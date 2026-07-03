// Agent 基类 — 通过 opencode CLI（opencode run）调用 LLM
// 使用 CLI 而非 HTTP API，因为 REST API 对当前模型存在挂死问题

import { execSync } from 'child_process';
import type { ModelConfig } from '../types/config.js';

/**
 * Escape a string for safe use in a shell echo statement.
 * Wraps in single quotes and escapes any single quotes inside.
 */
function shellEcho(value: string): string {
  // Replace single quotes with end-quote + escaped quote + start-quote
  const escaped = value.replace(/'/g, "'\\''");
  return `'${escaped}'`;
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

  /** 通过 opencode CLI 发送 prompt，获取文本回复 */
  async prompt(content: string): Promise<string> {
    const fullPrompt = this.systemPrompt
      ? `${this.systemPrompt}\n\n---\n\n${content}`
      : content;
    const modelArg = `${this.model.providerID}/${this.model.modelID}`;

    try {
      const output = execSync(
        `echo ${shellEcho(fullPrompt)} | opencode run -m ${shellEcho(modelArg)} 2>/dev/null`,
        { timeout: 300_000, maxBuffer: 2 * 1024 * 1024 },
      );
      const text = output.toString('utf-8').trim();
      if (!text) {
        throw new Error(`Agent ${this.name}: empty response from LLM`);
      }
      return text;
    } catch (err) {
      if (err && typeof err === 'object' && 'stderr' in err) {
        const stderr = (err as { stderr: Buffer }).stderr.toString('utf-8');
        throw new Error(`Agent ${this.name} CLI error: ${stderr.slice(0, 500)}`);
      }
      throw err;
    }
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

    // 4. 最后兜底:把原始输出回喂给 LLM,要求自身修复 JSON 语法
    try {
      const repairPrompt =
        `你上一条回复不是合法 JSON,JSON.parse 失败于 ${diag}。\n` +
        `请只输出修复后的完整 JSON(以 { 开头,以 } 结尾),不要任何解释、不要 markdown 代码块。\n` +
        `常见问题:数组元素缺少引号包裹(如数字+中文混合 such as -8.27%月跌幅)、字段名未加引号、字符串内部出现未转义的双引号。\n` +
        `请确保所有字符串值都用双引号包裹,字符串内的双引号用 \\" 转义。\n\n` +
        `原始输出(需要修复):\n${text}`;
      const repairedText = await this.prompt(repairPrompt);

      let repairedClean = deepClean(repairedText);
      parsed = tryParse(repairedClean);
      if (parsed) return parsed;

      // 再走一遍 code-block 提取 + 最外层 JSON 提取 + 状态机修复
      const repairedCodeBlock = repairedClean.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (repairedCodeBlock) {
        parsed = tryParse(deepClean(repairedCodeBlock[1]));
        if (parsed) return parsed;
      }
      const repairedJsonMatch = repairedClean.match(/\{[\s\S]*\}/);
      if (repairedJsonMatch) {
        parsed = tryParse(repairedJsonMatch[0]);
        if (parsed) return parsed;
      }
    } catch {
      // self-heal 自身失败就放弃,继续抛原错
    }

    throw new Error(`Agent ${this.name}: Failed to parse structured output.\n  JSON解析错误: ${diag}\n  前300字符: ${text.slice(0, 300)}`);
  }

  async cleanup(): Promise<void> {
    // CLI 模式无需清理
  }
}
