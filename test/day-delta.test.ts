import { describe, it, expect } from 'vitest';
import { buildDayDelta, buildDriverMoves, formatDayDeltaMarkdown } from '../src/utils/day-delta.js';
import type { GoldAnalysisReport } from '../src/types/analysis.js';

function stubReport(partial: {
  score: number;
  quant?: number | null;
  positionTargetPct?: number;
  scenarios?: { base: number; upside: number; downside: number };
}): GoldAnalysisReport {
  const scenarios = partial.scenarios ?? { base: 50, upside: 25, downside: 25 };
  return {
    timestamp: '2026-07-24T00:00:00Z',
    marketData: {} as GoldAnalysisReport['marketData'],
    dataQuality: { overallConfidence: 70, warnings: [] },
    technical: { score: 50 } as GoldAnalysisReport['technical'],
    fundamental: { score: 50 } as GoldAnalysisReport['fundamental'],
    sentiment: { score: 50 } as GoldAnalysisReport['sentiment'],
    overall: {
      score: partial.score,
      quantScore: partial.quant ?? null,
      direction: 'neutral',
      positionTargetPct: partial.positionTargetPct,
      scenarios: {
        base: { probability: scenarios.base, description: '', action: '' },
        upside: { probability: scenarios.upside, description: '', action: '' },
        downside: { probability: scenarios.downside, description: '', action: '' },
      },
    },
  } as GoldAnalysisReport;
}

describe('buildDriverMoves', () => {
  it('标出利率升为利空、美元跌为利多', () => {
    const moves = buildDriverMoves(
      {
        date: '2026-07-23',
        londonClose: 2400,
        tipsYield: 1.8,
        us10yYield: 4.2,
        dollarIndex: 104,
      } as never,
      {
        date: '2026-07-24',
        londonClose: 2410,
        tipsYield: 1.95,
        us10yYield: 4.25,
        dollarIndex: 103.2,
      } as never,
      55,
      60,
    );
    const tips = moves.find(m => m.key === 'tips');
    const dxy = moves.find(m => m.key === 'dxy');
    const flow = moves.find(m => m.key === 'flow');
    expect(tips?.goldBias).toBe('headwind');
    expect(dxy?.goldBias).toBe('supportive');
    expect(flow?.goldBias).toBe('supportive');
  });
});

describe('buildDayDelta', () => {
  it('变化很小时标记可跳过细读', () => {
    const prev = stubReport({ score: 55, quant: 54, positionTargetPct: 55 });
    const curr = stubReport({ score: 56, quant: 55, positionTargetPct: 55 });
    const d = buildDayDelta({
      prevDate: '2026-07-23',
      currDate: '2026-07-24',
      previous: prev,
      current: curr,
      currPositionPct: 55,
    });
    expect(d.skipFineRead).toBe(true);
    expect(d.headline).toMatch(/可跳过细读/);
  });

  it('分数/仓位显著变化时给出差分 headline', () => {
    const prev = stubReport({
      score: 50,
      quant: 48,
      positionTargetPct: 45,
      scenarios: { base: 50, upside: 20, downside: 30 },
    });
    const curr = stubReport({
      score: 62,
      quant: 55,
      positionTargetPct: 65,
      scenarios: { base: 45, upside: 30, downside: 25 },
    });
    const d = buildDayDelta({
      prevDate: '2026-07-23',
      currDate: '2026-07-24',
      previous: prev,
      current: curr,
      currPositionPct: 65,
      llmHitRate: 62,
      quantHitRate: 48,
    });
    expect(d.skipFineRead).toBe(false);
    expect(d.scoreDelta).toBe(12);
    expect(d.positionDelta).toBe(20);
    expect(d.headline).toMatch(/较昨日有变化/);
    expect(d.trackHint).toMatch(/叙事可略偏LLM/);
    const md = formatDayDeltaMarkdown(d);
    expect(md).toContain('## 📅 较昨日一览');
    expect(md).toContain('| 综合分 |');
  });

  it('无昨日报告时不声称持平', () => {
    const curr = stubReport({ score: 60 });
    const d = buildDayDelta({
      prevDate: '',
      currDate: '2026-07-24',
      previous: null,
      current: curr,
      currPositionPct: 60,
    });
    expect(d.headline).toMatch(/无昨日/);
    expect(d.skipFineRead).toBe(true);
  });
});
