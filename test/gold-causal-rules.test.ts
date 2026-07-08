import { describe, it, expect } from 'vitest';
import { matchCausalChains } from '../src/utils/gold-causal-rules';
import { detectMacroRegime } from '../src/utils/macro-regime';
import type { MarketData } from '../src/types/market';

function market(partial: Partial<MarketData> & Pick<MarketData, 'timestamp'>): MarketData {
  return {
    london: { price: { value: 4100, change: 0, source: '', sourceGrade: 'B', verifiedAt: '' } },
    shanghai: { price: { value: 900, change: 0, source: '', sourceGrade: 'B', verifiedAt: '' } },
    etf: { code: '518880', name: '', nav: { value: 5, change: 0, source: '', sourceGrade: 'B', verifiedAt: '' } },
    dollarIndex: { value: { value: 101, change: 0.5, source: '', sourceGrade: 'B', verifiedAt: '' } },
    usTreasury: { yield10y: { value: 4.2, change: 0, source: '', sourceGrade: 'B', verifiedAt: '' }, tips: { value: 2.2, source: '', sourceGrade: 'B', verifiedAt: '' } },
    ...partial,
  } as MarketData;
}

describe('matchCausalChains', () => {
  it('美元走强命中利空规则', () => {
    const m = market({ timestamp: 't', dollarIndex: { value: { value: 102, change: 0.6, source: '', sourceGrade: 'B', verifiedAt: '' } } });
    const regime = detectMacroRegime(m, null);
    const chains = matchCausalChains(m, regime, null);
    expect(chains.some(c => c.ruleId === 'dxy_up_gold_down')).toBe(true);
  });
});
