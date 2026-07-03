import { describe, it, expect } from 'vitest';
import { diffReports } from '../src/utils/report-diff';
import type { GoldAnalysisReport } from '../src/types/analysis';

function miniReport(score: number, tech: number, probBase: number): GoldAnalysisReport {
  return {
    timestamp: '2026-06-24T00:00:00.000Z',
    marketData: {} as GoldAnalysisReport['marketData'],
    dataQuality: { overallConfidence: 80, warnings: [] },
    technical: { score: tech, direction: 'neutral', keyPoints: [], counterPoints: [], summary: '', sources: [], shortTerm: {} as never, midTerm: {} as never },
    fundamental: { score: 60, direction: 'neutral', keyPoints: [], counterPoints: [], summary: '', sources: [], dollarIndexEffect: '', interestRateEffect: '', inflationEffect: '', fedStance: '' },
    sentiment: { score: 60, direction: 'neutral', keyPoints: [], counterPoints: [], summary: '', sources: [], centralBanks: '', cftcPosition: '', vix: '', geopoliticalRisk: '', etfFlows: '' },
    fund: { recommendation: { longTerm: '', mediumTerm: '', dipBuy: '' }, valuation: { level: 'fair', indicator: '', action: '' }, premiumDiscount: { current: 0, trend: '', advice: '' } },
    rebuttal: { bullScore: 50, bearScore: 50, rebuttalStrength: 'weak', bearPoints: [], bullVulnerabilities: [], netEffect: 'unchanged', adjustedScore: score, tailRisks: [] },
    tailRisks: [],
    overall: {
      score,
      direction: 'neutral',
      scenarios: {
        base: { probability: probBase, description: '', goldPrice: '', action: '', confidence: 'moderate' },
        upside: { probability: 20, description: '', goldPrice: '', action: '', confidence: 'low', trigger: '' },
        downside: { probability: 20, description: '', goldPrice: '', action: '', confidence: 'low', trigger: '' },
      },
      calibration: { scoreRange: '', historicalAccuracy: null, systematicBias: '', sampleSize: 0 },
      shortTerm: {} as never,
      midTerm: {} as never,
    },
  };
}

describe('diffReports', () => {
  it('计算综合分与各维度变化', () => {
    const d = diffReports('2026-06-27', '2026-06-28', miniReport(65, 70, 50), miniReport(58, 52, 55));
    const overall = d.lines.find(l => l.field === '综合分');
    expect(overall?.delta).toBe('-7');
    expect(d.headline).toContain('下调');
  });
});
