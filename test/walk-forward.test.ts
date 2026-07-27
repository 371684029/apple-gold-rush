import { describe, it, expect } from 'vitest';
import {
  summarizeWalkForward,
  formatWalkForwardMarkdown,
  computeOosHitStats,
} from '../src/utils/walk-forward.js';
import type { CalibrationReport } from '../src/types/calibration.js';
import type { GoldPricesRepo } from '../src/db/gold-prices.js';
import type { AnalysisReportRow } from '../src/db/reports.js';
import { forwardReturnPct } from '../src/utils/forward-return.js';

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

  it('附带测试窗 OOS 命中时写入摘要与 CI', () => {
    const train = stubCal('2026-01-01', '2026-03-01', [8, 9, 10]);
    const test = stubCal('2026-03-02', '2026-06-01', [9, 10, 11]);
    const wf = summarizeWalkForward(train, test, {
      hits: 7,
      total: 10,
      hitRate: 70,
      ciLow: 39.7,
      ciHigh: 89.2,
      baselineRate: 55,
    });
    expect(wf.oosLlmHits).toBe(7);
    expect(wf.oosLlmTotal).toBe(10);
    expect(wf.oosBaselineRate).toBe(55);
    expect(wf.summary).toMatch(/测试窗 LLM 方向命中/);
    expect(formatWalkForwardMarkdown(wf)).toContain('95%CI 39.7–89.2%');
  });
});

describe('computeOosHitStats', () => {
  it('在测试窗上按 5 日前瞻独立记账', () => {
    // 报告日偏多 + 5 日后上涨 → 命中；偏空 + 5 日后下跌 → 命中
    const closes: Record<string, number> = {
      '2026-06-01': 4000,
      '2026-06-02': 4010,
      '2026-06-03': 4020,
      '2026-06-04': 4030,
      '2026-06-05': 4040,
      '2026-06-08': 4100,
      '2026-06-09': 3900,
      '2026-06-10': 3880,
      '2026-06-11': 3860,
      '2026-06-12': 3840,
      '2026-06-15': 3820,
      '2026-06-16': 3800,
    };
    const sorted = Object.keys(closes).sort();
    const prices = {
      getByDate: (date: string) => {
        const c = closes[date];
        return c != null
          ? {
              date,
              londonClose: c,
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
            }
          : undefined;
      },
      getAfter: (date: string, limit: number) =>
        sorted
          .filter(d => d > date)
          .slice(0, limit)
          .map(d => ({
            date: d,
            londonClose: closes[d],
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
          })),
    } as unknown as GoldPricesRepo;

    expect(forwardReturnPct(prices, '2026-06-01', 5, { allowPartial: false })).toBeGreaterThan(0.1);

    const reports: AnalysisReportRow[] = [
      { id: 1, date: '2026-06-01', horizon: 'all', reportJson: '{}', overallScore: 70, direction: 'bullish', quantScore: null, midTermScore: null, createdAt: '' },
      { id: 2, date: '2026-06-09', horizon: 'all', reportJson: '{}', overallScore: 30, direction: 'bearish', quantScore: null, midTermScore: null, createdAt: '' },
    ];

    const oos = computeOosHitStats({ testReports: reports, prices, horizonDays: 5 });
    expect(oos.total).toBe(2);
    expect(oos.hits).toBe(2);
    expect(oos.hitRate).toBe(100);
    expect(oos.baselineRate).not.toBeNull();
  });
});
