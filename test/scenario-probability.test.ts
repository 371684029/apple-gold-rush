import { describe, it, expect } from 'vitest';
import { computeScenarioProbabilities, applyScenarioProbabilities } from '../src/utils/scenario-probability';
import type { PatternMatch } from '../src/types/calibration';
import type { Scenarios } from '../src/types/analysis';

const baseScenarios: Scenarios = {
  base: { probability: 50, description: 'b', goldPrice: '', action: '', confidence: 'moderate' },
  upside: { probability: 25, description: 'u', goldPrice: '', action: '', confidence: 'low', trigger: '' },
  downside: { probability: 25, description: 'd', goldPrice: '', action: '', confidence: 'low', trigger: '' },
};

describe('computeScenarioProbabilities', () => {
  it('样本不足返回 insufficient', () => {
    const r = computeScenarioProbabilities([]);
    expect(r.source).toBe('insufficient');
  });

  it('统计相似日收益并保证下行≥15%', () => {
    const matches: PatternMatch[] = [
      { date: 'a', reportId: 1, similarity: 0.8, direction: 'neutral', score: 50, actualReturn: 2, actual5dReturn: 2 },
      { date: 'b', reportId: 2, similarity: 0.7, direction: 'neutral', score: 48, actualReturn: -2, actual5dReturn: -2 },
      { date: 'c', reportId: 3, similarity: 0.6, direction: 'neutral', score: 52, actualReturn: 0.5, actual5dReturn: 0.5 },
    ];
    const r = computeScenarioProbabilities(matches);
    expect(r.source).toBe('historical');
    expect(r.downside).toBeGreaterThanOrEqual(15);
    expect(r.base + r.upside + r.downside).toBe(100);
  });
});

describe('applyScenarioProbabilities', () => {
  it('historical 时覆盖概率', () => {
    const probs = computeScenarioProbabilities([
      { date: 'a', reportId: 1, similarity: 0.8, direction: 'neutral', score: 50, actualReturn: 3, actual5dReturn: 3 },
      { date: 'b', reportId: 2, similarity: 0.7, direction: 'neutral', score: 48, actualReturn: -3, actual5dReturn: -3 },
      { date: 'c', reportId: 3, similarity: 0.6, direction: 'neutral', score: 52, actualReturn: 0, actual5dReturn: 0 },
    ]);
    const out = applyScenarioProbabilities(baseScenarios, probs);
    expect(out.base.probability).toBe(probs.base);
    expect(out.downside.probability).toBeGreaterThanOrEqual(15);
  });
});
