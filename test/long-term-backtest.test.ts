import { describe, it, expect } from 'vitest';
import { computeHistoricalReturnBands } from '../src/utils/long-term-backtest';
import type { GoldPriceRecord } from '../src/types/market';

describe('computeHistoricalReturnBands', () => {
  it('足够长序列产出分位数', () => {
    const prices: GoldPriceRecord[] = [];
    for (let i = 0; i < 600; i++) {
      prices.push({
        date: `2024-${String((i % 28) + 1).padStart(2, '0')}`,
        londonClose: 100 + Math.sin(i / 20) * 5 + i * 0.01,
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
      });
    }
    const bands = computeHistoricalReturnBands(prices);
    expect(bands.length).toBeGreaterThan(0);
    expect(bands[0].sampleSize).toBeGreaterThanOrEqual(5);
  });
});
