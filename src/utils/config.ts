// 配置管理

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, type GoldRushConfig } from '../types/config.js';

const CONFIG_FILENAME = 'goldrush.config.json';

let config: GoldRushConfig | null = null;

/** 深合并（仅对象层，数组/原始值直接覆盖） */
function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const val = override[key];
    const baseVal = base[key];
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key as keyof T] = deepMerge(
        baseVal as Record<string, unknown>,
        val as Record<string, unknown>,
      ) as T[keyof T];
    } else if (val !== undefined) {
      result[key as keyof T] = val as T[keyof T];
    }
  }
  return result;
}

/** 兼容 goldrush.config.json 中的 llm.models 嵌套写法 */
function normalizeUserConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...raw };
  const llm = raw.llm;
  if (llm && typeof llm === 'object' && !Array.isArray(llm)) {
    const llmObj = llm as Record<string, unknown>;
    if (llmObj.models && typeof llmObj.models === 'object') {
      normalized.models = llmObj.models;
    }
  }
  delete normalized.llm;
  return normalized;
}

/** 加载配置 */
export function loadConfig(configPath?: string): GoldRushConfig {
  if (config) return config;

  const resolvedPath = configPath ?? path.resolve(process.cwd(), CONFIG_FILENAME);
  let loaded: GoldRushConfig;

  if (fs.existsSync(resolvedPath)) {
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf-8');
      const userConfig = normalizeUserConfig(JSON.parse(raw) as Record<string, unknown>);
      loaded = deepMerge(
        { ...DEFAULT_CONFIG } as unknown as Record<string, unknown>,
        userConfig,
      ) as unknown as GoldRushConfig;
    } catch {
      loaded = { ...DEFAULT_CONFIG };
    }
  } else {
    loaded = { ...DEFAULT_CONFIG };
  }

  // 从环境变量覆盖
  if (process.env.TAVILY_API_KEY) {
    loaded.search.tavilyApiKey = process.env.TAVILY_API_KEY;
  }
  if (process.env.GOLDRUSH_WEBHOOK_URL) {
    loaded.alerts.webhookUrl = process.env.GOLDRUSH_WEBHOOK_URL;
  }
  if (process.env.GOLDRUSH_WEBHOOK_TYPE) {
    const t = process.env.GOLDRUSH_WEBHOOK_TYPE;
    if (t === 'dingtalk' || t === 'wecom' || t === 'generic') {
      loaded.alerts.webhookType = t;
    }
  }

  config = loaded;
  return config;
}

/** 获取当前配置 */
export function getConfig(): GoldRushConfig {
  return loadConfig();
}

/** 保存配置 */
export function saveConfig(cfg: Partial<GoldRushConfig>, configPath?: string): void {
  const current = loadConfig(configPath);
  const merged = deepMerge(
    current as unknown as Record<string, unknown>,
    cfg as unknown as Record<string, unknown>,
  ) as unknown as GoldRushConfig;
  const resolvedPath = configPath ?? path.resolve(process.cwd(), CONFIG_FILENAME);
  fs.writeFileSync(resolvedPath, JSON.stringify(merged, null, 2), 'utf-8');
  config = merged;
}

/** 测试用：重置配置缓存 */
export function resetConfigCache(): void {
  config = null;
}
