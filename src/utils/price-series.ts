// 金价序列工具

import type { GoldPriceRecord } from '../types/market.js';
import { deviationFromMA } from '../indicators/index.js';

/** 有效伦敦金收盘（拒绝 null 与 ≤0，避免 0 污染 MA/RSI） */
function validClose(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v) && v > 0;
}

/** 收盘价 forward-fill，保持与 records 时间序一致；跳过 0/无效价 */
export function forwardFillCloses(records: GoldPriceRecord[]): number[] {
  const closes: number[] = [];
  let last: number | null = null;
  for (const r of records) {
    if (validClose(r.londonClose)) last = r.londonClose;
    if (last != null) closes.push(last);
  }
  return closes;
}

/** 最新收盘价相对 MA 的偏离度（%） */
export function latestDeviationFromMA(closes: number[], period = 20): number | null {
  if (closes.length < period) return null;
  const dev = deviationFromMA(closes, period);
  const last = dev.filter((v): v is number => v !== null).pop();
  return last ?? null;
}
