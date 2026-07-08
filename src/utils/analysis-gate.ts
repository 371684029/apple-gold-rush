// 分析推理门控 — 低波动日跳过 LLM 深度分析

import type { GoldPriceRecord } from '../types/market.js';

export interface AnalysisGateResult {
  mode: 'calm' | 'volatile';
  goldVolatilityPct: number;
  dxyVolatilityPct: number;
  reason: string;
}

const DEFAULT_GOLD_THRESHOLD = 1.0;
const DEFAULT_DXY_THRESHOLD = 0.5;

/**
 * 根据最近 3 个交易日金价/美元波动判定是否触发完整分析。
 * 需至少 2 条有效收盘价。
 */
export function evaluateAnalysisGate(
  recentPrices: GoldPriceRecord[],
  opts?: { goldThreshold?: number; dxyThreshold?: number },
): AnalysisGateResult {
  const goldThreshold = opts?.goldThreshold ?? DEFAULT_GOLD_THRESHOLD;
  const dxyThreshold = opts?.dxyThreshold ?? DEFAULT_DXY_THRESHOLD;

  const withClose = recentPrices.filter(p => p.londonClose != null && p.londonClose > 0);
  if (withClose.length < 2) {
    return {
      mode: 'volatile',
      goldVolatilityPct: 0,
      dxyVolatilityPct: 0,
      reason: '历史金价不足，默认完整分析',
    };
  }

  const last = withClose[withClose.length - 1];
  const prev = withClose[withClose.length - 2];
  const goldVol = Math.abs((last.londonClose! - prev.londonClose!) / prev.londonClose!) * 100;

  let dxyVol = 0;
  if (last.dollarIndex != null && prev.dollarIndex != null && prev.dollarIndex > 0) {
    dxyVol = Math.abs((last.dollarIndex - prev.dollarIndex) / prev.dollarIndex) * 100;
  }

  const volatile = goldVol >= goldThreshold || dxyVol >= dxyThreshold;
  return {
    mode: volatile ? 'volatile' : 'calm',
    goldVolatilityPct: Math.round(goldVol * 100) / 100,
    dxyVolatilityPct: Math.round(dxyVol * 100) / 100,
    reason: volatile
      ? `金价波动 ${goldVol.toFixed(2)}% 或美元波动 ${dxyVol.toFixed(2)}% 超阈值`
      : `金价波动 ${goldVol.toFixed(2)}%、美元 ${dxyVol.toFixed(2)}%，行情平稳`,
  };
}
