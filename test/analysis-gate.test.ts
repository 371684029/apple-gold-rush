import { describe, it, expect } from 'vitest';
import { evaluateAnalysisGate } from '../src/utils/analysis-gate';
import type { GoldPriceRecord } from '../src/types/market';

function row(date: string, close: number, dxy: number): GoldPriceRecord {
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
    dollarIndex: dxy,
    us10yYield: null,
    tipsYield: null,
    createdAt: '',
  };
}

describe('evaluateAnalysisGate', () => {
  it('低波动判定为 calm', () => {
    const r = evaluateAnalysisGate([row('2026-07-06', 4100, 101), row('2026-07-07', 4105, 101.1)]);
    expect(r.mode).toBe('calm');
  });

  it('金价大波动判定为 volatile', () => {
    const r = evaluateAnalysisGate([row('2026-07-06', 4100, 101), row('2026-07-07', 4200, 101)]);
    expect(r.mode).toBe('volatile');
  });
});
