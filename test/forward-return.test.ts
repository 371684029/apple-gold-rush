import { describe, it, expect } from 'vitest';
import { forwardReturn, forwardReturnPct } from '../src/utils/forward-return.js';
import type { GoldPricesRepo } from '../src/db/gold-prices.js';

/** 用 { 日期: 收盘 } 造一个最小 GoldPricesRepo */
function repoOf(map: Record<string, number | null>): GoldPricesRepo {
  const keys = Object.keys(map).sort();
  return {
    getByDate(date: string) {
      if (!(date in map)) return undefined;
      return { date, londonClose: map[date] };
    },
    getAfter(date: string, limit: number) {
      const idx = keys.indexOf(date);
      if (idx < 0) return [];
      return keys.slice(idx + 1, idx + 1 + limit).map(d => ({ date: d, londonClose: map[d] }));
    },
  } as unknown as GoldPricesRepo;
}

/** 2026-06-01 起连续 N 天，每天 +1% */
function risingSeries(days: number, start = 1000): Record<string, number> {
  const out: Record<string, number> = {};
  let px = start;
  for (let i = 0; i < days; i++) {
    out[`2026-06-${String(i + 1).padStart(2, '0')}`] = px;
    px *= 1.01;
  }
  return out;
}

describe('前瞻收益窗口', () => {
  it('起点是报告当日收盘，而非次日', () => {
    const prices = repoOf({ '2026-06-01': 100, '2026-06-02': 110, '2026-06-03': 121 });
    // 起点若错用次日（110），2 日收益会算成 +10%
    expect(forwardReturnPct(prices, '2026-06-01', 2)).toBeCloseTo(21, 5);
  });

  it('终点是其后第 T 个有效交易日', () => {
    const prices = repoOf({ '2026-06-01': 100, '2026-06-02': 105, '2026-06-03': 110 });
    expect(forwardReturnPct(prices, '2026-06-01', 1)).toBeCloseTo(5, 5);
    expect(forwardReturnPct(prices, '2026-06-01', 2)).toBeCloseTo(10, 5);
  });

  it('T 日与 T+1 日的窗口确实差一天', () => {
    const prices = repoOf(risingSeries(30));
    const r5 = forwardReturn(prices, '2026-06-01', 5)!;
    const r6 = forwardReturn(prices, '2026-06-01', 6)!;
    expect(r5.actualDays).toBe(5);
    expect(r6.actualDays).toBe(6);
    expect(r6.returnPct).toBeGreaterThan(r5.returnPct);
  });
});

describe('数据不足与脏数据', () => {
  it('默认不允许部分窗口', () => {
    const prices = repoOf({ '2026-06-01': 100, '2026-06-02': 105 });
    expect(forwardReturnPct(prices, '2026-06-01', 5)).toBeNull();
  });

  it('显式允许时可用部分窗口并标记 partial', () => {
    const prices = repoOf({
      '2026-06-01': 100, '2026-06-02': 105, '2026-06-03': 110, '2026-06-04': 115,
    });
    const r = forwardReturn(prices, '2026-06-01', 5, { allowPartial: true, minPartialDays: 3 })!;
    expect(r.partial).toBe(true);
    expect(r.actualDays).toBe(3);
  });

  it('部分窗口天数不够下限时仍返回 null', () => {
    const prices = repoOf({ '2026-06-01': 100, '2026-06-02': 105 });
    expect(forwardReturnPct(prices, '2026-06-01', 5, { allowPartial: true, minPartialDays: 3 })).toBeNull();
  });

  it('跳过 0 与 null 收盘，不把脏数据当成暴跌', () => {
    const prices = repoOf({
      '2026-06-01': 100,
      '2026-06-02': 0,
      '2026-06-03': null,
      '2026-06-04': 110,
    });
    expect(forwardReturnPct(prices, '2026-06-01', 1)).toBeCloseTo(10, 5);
  });

  it('起点无效收盘直接返回 null', () => {
    const prices = repoOf({ '2026-06-01': 0, '2026-06-02': 110 });
    expect(forwardReturnPct(prices, '2026-06-01', 1)).toBeNull();
  });

  it('无未来数据返回 null', () => {
    const prices = repoOf({ '2026-06-01': 100 });
    expect(forwardReturnPct(prices, '2026-06-01', 5)).toBeNull();
  });
});
