import { describe, it, expect } from 'vitest';
import { detectMacroRegime } from '../src/utils/macro-regime';
import type { MarketData } from '../src/types/market';

function baseMarket(overrides: Partial<{
  tips: number;
  dxyChange: number;
  yield10y: number;
}> = {}): MarketData {
  return {
    timestamp: '2026-06-24T00:00:00.000Z',
    london: { price: { value: 2350, change: 0.5, source: 'x', sourceGrade: 'B', verifiedAt: '' } },
    shanghai: { price: { value: 545, change: 0.3, source: 'x', sourceGrade: 'A', verifiedAt: '' } },
    etf: { code: '518880', name: 'ETF', nav: { value: 5.2, change: 0.1, source: 'x', sourceGrade: 'B', verifiedAt: '' } },
    dollarIndex: { value: { value: 104, change: overrides.dxyChange ?? 0, source: 'x', sourceGrade: 'B', verifiedAt: '' } },
    usTreasury: {
      yield10y: { value: overrides.yield10y ?? 4.2, change: 0, source: 'x', sourceGrade: 'B', verifiedAt: '' },
      tips: { value: overrides.tips ?? 2.1, source: 'x', sourceGrade: 'B', verifiedAt: '' },
    },
  };
}

describe('detectMacroRegime', () => {
  it('高 TIPS 判定为实际利率压制', () => {
    const r = detectMacroRegime(baseMarket({ tips: 2.3 }));
    expect(r.tag).toBe('real_rate_headwind');
  });

  it('低 TIPS + 美元走弱为降息预期', () => {
    const r = detectMacroRegime(baseMarket({ tips: 1.2, dxyChange: -0.5 }));
    expect(r.tag).toBe('dovish_pivot_watch');
  });

  it('显著低于 MA20 为超卖修复', () => {
    const r = detectMacroRegime(baseMarket(), -8);
    expect(r.tag).toBe('oversold_repair');
  });
});
