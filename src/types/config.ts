// 配置类型定义

/** LLM 模型配置 */
export interface ModelConfig {
  providerID: string;
  modelID: string;
}

/** 投资视角 */
export type Horizon = 'short' | 'mid' | 'all';

/** 分析命令选项 */
export interface AnalysisOptions {
  horizon: Horizon;
  json: boolean;
  save: boolean;
  md: boolean;
}

/** 回测命令选项 */
export interface CalibrateOptions {
  days: number;
  detail: boolean;
}

/** 全局配置 */
export interface GoldRushConfig {
  models: {
    dataCollector: ModelConfig;
    validator: ModelConfig;
    technical: ModelConfig;
    fundamental: ModelConfig;
    sentiment: ModelConfig;
    fund: ModelConfig;
    rebuttal: ModelConfig;
    orchestrator: ModelConfig;
  };
  search: {
    tavilyApiKey: string;
    defaultResults: number;
    cacheMinutes: number;
  };
  database: {
    path: string;
  };
  investment: {
    defaultHorizon: Horizon;
    stopLossRange: [number, number]; // [min, max] %
    maxTailRiskIndex: number;
  };
}

/** 默认配置 */
export const DEFAULT_CONFIG: GoldRushConfig = {
  models: {
    dataCollector: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
    validator: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
    technical: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
    fundamental: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
    sentiment: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
    fund: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
    rebuttal: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
    orchestrator: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
  },
  search: {
    tavilyApiKey: '',
    defaultResults: 5,
    cacheMinutes: 5,
  },
  database: {
    path: './data/goldrush.db',
  },
  investment: {
    defaultHorizon: 'all',
    stopLossRange: [3, 5],
    maxTailRiskIndex: 20,
  },
};
