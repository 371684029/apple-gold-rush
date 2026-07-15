import { describe, it, expect } from 'vitest';
import { evaluateDataQualityGate } from '../src/utils/data-quality-gate';
import { singleSourceConfidence, weightedFieldConfidence, gradeSource, crossValidate } from '../src/utils/source-rank';
import type { MarketData } from '../src/types/market.js';

function mkMarket(opts: {
  london?: number | null;
  shanghai?: number | null;
  dxy?: number | null;
}): MarketData {
  const price = (v: number | null | undefined, source = 'test') =>
    v != null && v !== 0
      ? { value: v, change: 0, source, sourceGrade: 'A' as const, verifiedAt: 't' }
      : { value: 0, change: 0, source: 'N/A', sourceGrade: 'C' as const, verifiedAt: 't' };

  return {
    timestamp: new Date().toISOString(),
    london: { price: price(opts.london ?? null, 'gold-api.com'), altPrices: [] },
    shanghai: { price: price(opts.shanghai ?? null), altPrices: [] },
    etf: { code: '518880', name: 'x', nav: price(null) },
    dollarIndex: { value: price(opts.dxy ?? null) },
    usTreasury: {
      yield10y: price(null),
      tips: { value: 0, source: 'N/A', sourceGrade: 'C', verifiedAt: 't' },
    },
  };
}

describe('singleSourceConfidence', () => {
  it('A 级单源为 72 而非 55', () => {
    expect(singleSourceConfidence('A')).toBe(72);
    expect(singleSourceConfidence('B')).toBe(50);
    expect(singleSourceConfidence('C')).toBe(35);
  });

  it('crossValidate A 单源使用新分', () => {
    const r = crossValidate('london.price', [{
      value: 4000, source: 'gold-api.com', grade: 'A', timestamp: 't',
    }]);
    expect(r.confidence).toBe(72);
    expect(r.consensus).toBe('single_source');
  });
});

describe('gradeSource 锚定源', () => {
  it('gold-api / 新浪 / FRED 为 A', () => {
    expect(gradeSource('gold-api.com')).toBe('A');
    expect(gradeSource('sina hf_GC')).toBe('A');
    expect(gradeSource('FRED DGS10')).toBe('A');
    expect(gradeSource('Yahoo Finance GC=F')).toBe('A');
  });
});

describe('weightedFieldConfidence', () => {
  it('伦敦金 50% + 其余平均 50%', () => {
    const w = weightedFieldConfidence([
      { field: 'london.price', sources: [], consensus: 'single_source', finalValue: 1, confidence: 72 },
      { field: 'etf.nav', sources: [], consensus: 'single_source', finalValue: 1, confidence: 50 },
      { field: 'dollarIndex.value', sources: [], consensus: 'single_source', finalValue: 1, confidence: 50 },
    ]);
    // 72*0.5 + 50*0.5 = 61
    expect(w).toBe(61);
  });
});

describe('evaluateDataQualityGate', () => {
  it('无金价 → red 不可操作', () => {
    const g = evaluateDataQualityGate({
      marketData: mkMarket({ london: null }),
      overallConfidence: 80,
    });
    expect(g.tier).toBe('red');
    expect(g.actionable).toBe(false);
  });

  it('置信度 40 + 有效金价 → yellow 可操作', () => {
    const g = evaluateDataQualityGate({
      marketData: mkMarket({ london: 4050 }),
      overallConfidence: 40,
      anchorGoldPrice: 4055,
    });
    expect(g.tier).toBe('yellow');
    expect(g.actionable).toBe(true);
  });

  it('置信度 50 不再因 <55 被硬拦', () => {
    const g = evaluateDataQualityGate({
      marketData: mkMarket({ london: 4050 }),
      overallConfidence: 50,
      anchorGoldPrice: 4050,
    });
    expect(g.actionable).toBe(true);
    expect(g.tier).not.toBe('red');
  });

  it('置信度 <35 → red', () => {
    const g = evaluateDataQualityGate({
      marketData: mkMarket({ london: 4050 }),
      overallConfidence: 30,
      anchorGoldPrice: 4050,
    });
    expect(g.tier).toBe('red');
    expect(g.actionable).toBe(false);
  });

  it('锚定偏差 >3% → red', () => {
    const g = evaluateDataQualityGate({
      marketData: mkMarket({ london: 4000 }),
      overallConfidence: 80,
      anchorGoldPrice: 4200, // ~4.76%
    });
    expect(g.tier).toBe('red');
    expect(g.actionable).toBe(false);
  });

  it('高置信 + 锚定贴合 → green', () => {
    const g = evaluateDataQualityGate({
      marketData: mkMarket({ london: 4050, shanghai: 910, dxy: 104 }),
      overallConfidence: 75,
      validations: [
        { field: 'london.price', sources: [{ value: 4050, source: 'a', grade: 'A', timestamp: 't' }, { value: 4051, source: 'b', grade: 'A', timestamp: 't' }], consensus: 'verified', finalValue: 4050, confidence: 95 },
      ],
      anchorGoldPrice: 4052,
    });
    expect(g.tier).toBe('green');
    expect(g.actionable).toBe(true);
  });
});
