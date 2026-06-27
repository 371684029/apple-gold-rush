// Agent 基类 — 通过 opencode HTTP API 调用 LLM
import type { ModelConfig } from '../types/config.js';

const OPENCODE_SERVER = process.env.OPENCODE_SERVER || 'http://localhost:16688';
const OPENCODE_USERNAME = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
const OPENCODE_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || 'goldrush2026';

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${OPENCODE_USERNAME}:${OPENCODE_PASSWORD}`).toString('base64');
}

export interface AgentOptions {
  name: string;
  model: ModelConfig;
  systemPrompt?: string;
}

export class BaseAgent {
  protected name: string;
  protected model: ModelConfig;
  protected systemPrompt: string;

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt ?? '';
  }

  /** 创建新 session */
  private async createSession(): Promise<string> {
    const res = await fetch(`${OPENCODE_SERVER}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader(),
      },
    });

    if (!res.ok) {
      throw new Error(`Agent ${this.name}: create session failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as { id: string };
    return data.id;
  }

  /** 发送消息到 session，等待完整回复（带超时和重试） */
  private async sendMessage(sessionId: string, content: string, system?: string): Promise<string> {
    const body: Record<string, unknown> = {
      providerID: this.model.providerID,
      modelID: this.model.modelID,
      parts: [{ type: 'text', text: content }],
    };
    if (system) {
      body.system = system;
    }

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(`${OPENCODE_SERVER}/session/${sessionId}/message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader(),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(300_000), // 5 min timeout per request
        });

        if (!res.ok) {
          throw new Error(`Agent ${this.name}: send message failed: ${res.status} ${await res.text()}`);
        }

        const data = await res.json() as { parts: Array<{ type: string; text?: string }> };
        // 提取 text 类型的 parts 拼接成完整文本
        const textParts = (data.parts || [])
          .filter((p) => p.type === 'text' && p.text)
          .map((p) => p.text!)
          .join('\n');

        if (!textParts.trim()) {
          throw new Error(`Agent ${this.name}: empty response from LLM`);
        }

        return textParts;
      } catch (err) {
        const isLastAttempt = attempt === maxRetries;
        if (isLastAttempt) throw err;
        // 退避重试
        const delay = attempt * 5000;
        console.error(`  ⚠️ Agent ${this.name} attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}. Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    throw new Error(`Agent ${this.name}: all retries exhausted`);
  }

  /** 发送 prompt，获取文本回复 */
  async prompt(content: string): Promise<string> {
    const sessionId = await this.createSession();
    const text = await this.sendMessage(sessionId, content, this.systemPrompt || undefined);
    return text.trim();
  }

  /** 发送 prompt，获取结构化 JSON 输出 */
  async structuredPrompt<T>(content: string, _schema: Record<string, unknown>): Promise<T> {
    const jsonInstruction = `\n\n请严格按照上述 JSON 格式输出，不要包含任何其他文本。直接输出 JSON，不要用 markdown 代码块包裹。JSON中不要包含tab、换行等控制字符。`;
    const fullContent = content + jsonInstruction;

    const text = await this.prompt(fullContent);

    /** 尝试解析 JSON 字符串，含修复 */
    function tryParse(raw: string): T | null {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    }

    /** 深度清洁 JSON 文本 */
    function deepClean(s: string): string {
      let r = s
        // 移除控制字符（包括换行符——JSON 字符串值中不允许实际换行）
        .replace(/[\x00-\x1f]/g, ' ')
        // 移除转义换行/tab
        .replace(/\\\n/g, '')
        .replace(/\\t/g, ' ')
        // 中文引号 → 普通引号
        .replace(/\u201c/g, '"')
        .replace(/\u201d/g, '"')
        .replace(/\u2018/g, "'")
        .replace(/\u2019/g, "'")
        // 全角逗号 → 半角
        .replace(/，/g, ',')
        // 移除尾随逗号
        .replace(/,(\s*[}\]])/g, '$1')
        // 合并多余空白
        .replace(/\s{2,}/g, ' ')
        .trim();

      // 修复 JSON 字符串值中的无效转义序列（如 \d, \s, \c 等）
      // 只允许 JSON 合法的转义: \" \\ \/ \b \f \n \r \t \uXXXX
      r = r.replace(/\\([^"\\\/bfnrtu])/g, (_, c) => c);

      return r;
    }

    /** 获取 JSON.parse 失败的具体位置 */
    function getParseErrorDetail(raw: string): string {
      try {
        JSON.parse(raw);
        return '无错误';
      } catch (e) {
        const msg = String(e);
        // 提取位置信息，如 "position 1234" 或 "at position 1234"
        const posMatch = msg.match(/(?:position|at)\s*(\d+)/i);
        if (posMatch) {
          const pos = parseInt(posMatch[1], 10);
          const start = Math.max(0, pos - 40);
          const end = Math.min(raw.length, pos + 40);
          return `位置 ${pos}: ...${JSON.stringify(raw.slice(start, end))}...`;
        }
        return msg.slice(0, 200);
      }
    }

    // 1. 深度清洁后直接解析
    let cleaned = deepClean(text);
    let parsed = tryParse(cleaned);
    if (parsed) return parsed;

    // 2. 尝试从 markdown 代码块提取
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      parsed = tryParse(deepClean(codeBlockMatch[1]));
      if (parsed) return parsed;
    }

    // 3. 提取最外层 JSON 对象
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const jsonStr = jsonMatch[0];

      // 3a. 直接解析
      parsed = tryParse(jsonStr);
      if (parsed) return parsed;

      // 3b. 状态机修复：遍历字符，追踪字符串上下文，转义字符串值中未转义的双引号
      let fixed = '';
      let inString = false;
      let escapeNext = false;
      for (let i = 0; i < jsonStr.length; i++) {
        const ch = jsonStr[i];
        if (escapeNext) {
          fixed += ch;
          escapeNext = false;
          continue;
        }
        if (ch === '\\') {
          fixed += ch;
          escapeNext = true;
          continue;
        }
        if (ch === '"') {
          if (inString) {
            // 检查这个 " 是否真的是字符串结束
            // 如果后面跟的是 JSON 结构字符 (,:; 空格 } ]) 则是结束，否则是字符串内容
            const nextNonSpace = jsonStr.slice(i + 1).match(/\S/);
            const nextCh = nextNonSpace ? nextNonSpace[0] : '';
            if (nextCh === ',' || nextCh === '}' || nextCh === ']' || nextCh === ':' || nextCh === '') {
              inString = false;
              fixed += ch;
            } else {
              // 字符串内部的引号，转义
              fixed += '\\"';
            }
          } else {
            inString = true;
            fixed += ch;
          }
          continue;
        }
        fixed += ch;
      }
      parsed = tryParse(fixed);
      if (parsed) return parsed;
    }

    const diag = getParseErrorDetail(cleaned);
    throw new Error(`Agent ${this.name}: Failed to parse structured output.\n  JSON解析错误: ${diag}\n  前300字符: ${text.slice(0, 300)}`);
  }

  /** 清理资源 (HTTP API 模式无需清理) */
  async cleanup(): Promise<void> {
    // 每次 prompt 创建独立 session，无需清理
  }
}