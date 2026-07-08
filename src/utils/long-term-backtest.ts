// 长期展望历史回报带 — 基于本地金价序列回测分位数

import type { GoldPriceRecord } from '../types/market.js';
import type { Direction } from '../types/analysis.js';
import type { LongTermHorizonYears } from '../types/analysis.js';

export interface HistoricalReturnBand {
  years: LongTermHorizonYears;
  tradingDays: number;
  medianPct: number;
  p10Pct: number;
  p90Pct: number;
  sampleSize: number;
}

const HORIZON_DAYS: Record<LongTermHorizonYears, number> = {
  1: 252,
  3: 252 * 3,
  5: 252 * 5,
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 从历史收盘价计算各期限累计收益分位数。
 * 使用 GC=F 代理序列（与指标一致）。
 */
export function computeHistoricalReturnBands(
  prices: GoldPriceRecord[],
  yearsList: LongTermHorizonYears[] = [1, 3, 5],
): HistoricalReturnBand[] {
  const closes = prices
    .filter(p => p.londonClose != null && p.londonClose > 0)
    .map(p => p.londonClose!);

  const results: HistoricalReturnBand[] = [];

  for (const years of yearsList) {
    const horizon = HORIZON_DAYS[years];
    const returns: number[] = [];
    for (let i = 0; i + horizon < closes.length; i++) {
      const start = closes[i];
      const end = closes[i + horizon];
      if (start <= 0) continue;
      returns.push(((end - start) / start) * 100);
    }
    if (returns.length < 5) continue;
    const sorted = [...returns].sort((a, b) => a - b);
    results.push({
      years,
      tradingDays: horizon,
      medianPct: Math.round(percentile(sorted, 0.5) * 10) / 10,
      p10Pct: Math.round(percentile(sorted, 0.1) * 10) / 10,
      p90Pct: Math.round(percentile(sorted, 0.9) * 10) / 10,
      sampleSize: returns.length,
    });
  }

  return results;
}

/** 按方向偏好评选子样本（简化：偏多取收益>0 的窗口，偏空取<0） */
export function filterBandsByDirectionHint(
  prices: GoldPriceRecord[],
  direction: Direction,
  years: LongTermHorizonYears,
): HistoricalReturnBand | null {
  const closes = prices.filter(p => p.londonClose != null).map(p => p.londonClose!);
  const horizon = HORIZON_DAYS[years];
  const returns: number[] = [];
  for (let i = 0; i + horizon < closes.length; i++) {
    const start = closes[i];
    const end = closes[i + horizon];
    if (start <= 0) continue;
    const r = ((end - start) / start) * 100;
    if (direction === 'bullish' && r > 0) returns.push(r);
    else if (direction === 'bearish' && r < 0) returns.push(r);
    else if (direction === 'neutral') returns.push(r);
  }
  if (returns.length < 3) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  return {
    years,
    tradingDays: horizon,
    medianPct: Math.round(percentile(sorted, 0.5) * 10) / 10,
    p10Pct: Math.round(percentile(sorted, 0.1) * 10) / 10,
    p90Pct: Math.round(percentile(sorted, 0.9) * 10) / 10,
    sampleSize: returns.length,
  };
}

export function formatHistoricalBandLine(band: HistoricalReturnBand): string {
  const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  return `历史同期限（${band.sampleSize} 窗口）P10 ${sign(band.p10Pct)}% / 中位 ${sign(band.medianPct)}% / P90 ${sign(band.p90Pct)}%`;
}

export function enrichReturnBandWithHistory(
  heuristicBand: string,
  histBand: HistoricalReturnBand | null,
): string {
  if (!histBand) return heuristicBand;
  return `${heuristicBand}；${formatHistoricalBandLine(histBand)}（GC=F 代理，非承诺）`;
}
