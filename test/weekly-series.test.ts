import { describe, it, expect } from 'vitest';
import { aggregateWeeklyCloses, forwardFillLondonClose } from '../src/utils/weekly-series';
import type { GoldPriceRecord } from '../src/types/market';

function row(date: string, close: number | null): GoldPriceRecord {
  return {
    date,
    londonClose: close,
    londonHigh: null,
    londonLow: null,
    shanghaiClose: null,
    shanghaiHigh: null,
    shanghaiLow: null,
    etfNav: null,
    etfChange: null,
    dollarIndex: null,
    us10yYield: null,
    tipsYield: null,
    createdAt: '',
  };
}

describe('forwardFillLondonClose', () => {
  it('前向填充缺失收盘价', () => {
    const filled = forwardFillLondonClose([
      row('2026-06-02', 2000),
      row('2026-06-03', null),
    ]);
    expect(filled[1].londonClose).toBe(2000);
  });
});

describe('aggregateWeeklyCloses', () => {
  it('至少3个交易日才形成周线', () => {
    const weeks = aggregateWeeklyCloses([
      row('2026-06-01', 100),
      row('2026-06-02', 101),
    ]);
    expect(weeks.length).toBe(0);
  });
});
