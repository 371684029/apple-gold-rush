import { describe, it, expect } from 'vitest';
import { featureToVector, findSimilarPatterns } from '../src/utils/scenario-similarity';
import type { ScenarioFeature } from '../src/types/calibration';

function feat(partial: Partial<ScenarioFeature> & Pick<ScenarioFeature, 'date' | 'reportId'>): ScenarioFeature {
  return {
    id: partial.id ?? 1,
    dollarDirection: 'flat',
    dollarMagnitude: 0,
    tipsDirection: 'flat',
    tipsMagnitude: 0,
    goldDeviation: 0,
    vixLevel: 15,
    fedStance: 'neutral',
    geopoliticalRisk: 'medium',
    momentumDirection: 'flat',
    consecutiveDays: 0,
    actual5dReturn: null,
    actual5dDirection: null,
    actual20dReturn: null,
    backfillStatus: 'pending',
    createdAt: '',
    ...partial,
  };
}

describe('scenario-similarity', () => {
  it('相同特征相似度接近 1', () => {
    const f = feat({ date: '2026-06-01', reportId: 1, dollarDirection: 'up', dollarMagnitude: 1 });
    const v1 = featureToVector(f);
    const v2 = featureToVector({ ...f, id: 2, date: '2026-06-02', reportId: 2 });
    const sim = findSimilarPatterns(f, [f, { ...f, id: 2, date: '2026-06-02', reportId: 2 }], new Map([[2, { score: 60, direction: 'neutral' }]]), { excludeDate: '2026-06-01', minSimilarity: 0.9 });
    expect(sim.length).toBeGreaterThan(0);
    expect(sim[0].similarity).toBeGreaterThan(0.95);
    expect(v1.length).toBe(v2.length);
  });
});
