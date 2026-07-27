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

export interface MacroSeries {
  /** 按日期升序的有效观测值 */
  values: number[];
  /** 最后一个有效观测值的日期 */
  lastDate: string | null;
  /** 最后一个有效观测值距 asOf 的日历天数；无数据时为 null */
  ageDays: number | null;
}

/**
 * 抽取宏观序列并记录时效。
 *
 * 直接 filter 掉 null 会让「两周前的最后一个 TIPS」看起来和今天的一样新，
 * FRED 中断时量化因子会拿陈旧值当实时信号。这里把滞后天数一起带出来。
 */
export function pickMacroSeries(
  records: GoldPriceRecord[],
  pick: (r: GoldPriceRecord) => number | null | undefined,
  asOf?: string,
): MacroSeries {
  const values: number[] = [];
  let lastDate: string | null = null;
  for (const r of records) {
    const v = pick(r);
    if (v == null || !Number.isFinite(v)) continue;
    values.push(v);
    lastDate = r.date;
  }
  if (lastDate == null) return { values, lastDate: null, ageDays: null };

  const end = asOf ?? records[records.length - 1]?.date ?? lastDate;
  return { values, lastDate, ageDays: calendarDaysBetween(lastDate, end) };
}

/** 两个 YYYY-MM-DD 之间的日历天数差（to - from），解析失败返回 0 */
export function calendarDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** 最新收盘价相对 MA 的偏离度（%） */
export function latestDeviationFromMA(closes: number[], period = 20): number | null {
  if (closes.length < period) return null;
  const dev = deviationFromMA(closes, period);
  const last = dev.filter((v): v is number => v !== null).pop();
  return last ?? null;
}
