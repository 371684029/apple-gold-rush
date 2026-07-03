// 周线聚合 — 基于 forward-fill 后的日线

import type { GoldPriceRecord } from '../types/market.js';
import { todayDate } from './time.js';

/** 对缺失 londonClose 做前向填充（不改变原数组顺序） */
export function forwardFillLondonClose(records: GoldPriceRecord[]): GoldPriceRecord[] {
  let last: number | null = null;
  return records.map(r => {
    if (r.londonClose != null) last = r.londonClose;
    if (last != null && r.londonClose == null) {
      return { ...r, londonClose: last };
    }
    return r;
  });
}

/**
 * 将日线聚合为周线收盘（ISO 周一为界）。
 * 每周至少 3 个交易日才计入；收盘取该周最后一个有效 londonClose。
 */
export function aggregateWeeklyCloses(records: GoldPriceRecord[]): Array<{ weekStart: string; close: number }> {
  const filled = forwardFillLondonClose(records);
  const weekMap = new Map<string, number[]>();

  for (const r of filled) {
    if (r.londonClose == null) continue;
    const d = new Date(`${r.date}T12:00:00+08:00`);
    const day = d.getDay();
    const monOffset = day === 0 ? -6 : 1 - day;
    const mon = new Date(d);
    mon.setDate(d.getDate() + monOffset);
    const weekKey = todayDate(mon);

    if (!weekMap.has(weekKey)) weekMap.set(weekKey, []);
    weekMap.get(weekKey)!.push(r.londonClose);
  }

  const result: Array<{ weekStart: string; close: number }> = [];
  for (const [weekStart, closes] of weekMap) {
    if (closes.length < 3) continue;
    result.push({ weekStart, close: closes[closes.length - 1] });
  }
  return result.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}
