import { describe, it, expect } from 'vitest';
import { summarizeWalkForward, formatWalkForwardMarkdown } from '../src/utils/walk-forward.js';
import type { CalibrationReport } from '../src/types/calibration.js';

function stubCal(from: string, to: string, errors: number[]): CalibrationReport {
  return {
    period: { days: 30, from, to },
    totalReports: errors.length * 3,
    validReports: errors.length * 3,
    buckets: errors.map((calibrationError, i) => ({
      scoreRange: `${i * 20}-${i * 20 + 19}`,
      sampleSize: 5,
      predictedDirection: 'bullish' as const,
      actualUpCount: 3,
      actualUpProbability: 0.6,
      avgReturn: 1,
      calibrationError,
      systematicBias: 'calibrated' as const,
    })),
    overallBias: 0,
    riskAlertQuality: {
      redAlertCount: 0,
      redAlertHitCount: 0,
      redAlertHitRate: 0,
      missedAlerts: 0,
      missedRate: 0,
    },
    recommendations: [],
  };
}

describe('summarizeWalkForward', () => {
  it('样本外 MAE 变差时标记 degraded', () => {
    const train = stubCal('2026-01-01', '2026-03-01', [4, 5, 6]);
    const test = stubCal('2026-03-02', '2026-06-01', [14, 16, 18]);
    const wf = summarizeWalkForward(train, test);
    expect(wf.degraded).toBe(true);
    expect(wf.trainMae).toBe(5);
    expect(wf.testMae).toBe(16);
    expect(wf.summary).toMatch(/偏乐观|变差/);
    expect(formatWalkForwardMarkdown(wf)).toContain('Walk-forward');
  });

  it('样本外尚可时不 degraded', () => {
    const train = stubCal('2026-01-01', '2026-03-01', [8, 9, 10]);
    const test = stubCal('2026-03-02', '2026-06-01', [9, 10, 11]);
    const wf = summarizeWalkForward(train, test);
    expect(wf.degraded).toBe(false);
    expect(wf.summary).toMatch(/尚可/);
  });
});
