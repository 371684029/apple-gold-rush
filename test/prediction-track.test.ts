import { describe, it, expect } from 'vitest';
import {
  formatPredictionTrackMarkdown,
  type PredictionTrackStats,
} from '../src/utils/prediction-track';

function sampleStats(): PredictionTrackStats {
  return {
    asOf: '2026-07-16',
    windowDays: 90,
    sampleEligible: 12,
    llm: { hits: 7, total: 10, hitRate: 70 },
    quant: { hits: 4, total: 6, hitRate: 66.7 },
    highScoreUpRate: 62.5,
    highScoreN: 8,
    lowScoreUpRate: 40,
    lowScoreN: 5,
    conflictDays: 2,
    conflictFollowQuantHits: 1,
    conflictFollowLlmHits: 0,
    buckets: [
      { range: '50-60', sample: 4, upRate: 50, avgReturn: 0.3 },
      { range: '60-70', sample: 5, upRate: 60, avgReturn: 0.8 },
    ],
    recent: [
      {
        date: '2026-07-10',
        llmScore: 64,
        quantScore: 58,
        direction: 'bullish',
        pred: 'up',
        actual5dPct: 1.2,
        hit: true,
        status: 'hit',
        alignPct: 1.2,
        bucketAvgReturn: 0.8,
        vsBucketPct: 0.4,
        quantPred: 'up',
        quantHit: true,
        quantStatus: 'hit',
      },
      {
        date: '2026-07-15',
        llmScore: 52,
        quantScore: null,
        direction: 'neutral',
        pred: 'flat',
        actual5dPct: null,
        hit: null,
        status: 'pending',
        alignPct: null,
        bucketAvgReturn: null,
        vsBucketPct: null,
        quantPred: null,
        quantHit: null,
        quantStatus: null,
      },
    ],
    summary: 'LLM 方向命中 70% · 量化命中 67%',
  };
}

describe('prediction-track formatters', () => {
  it('Markdown 含关键统计表', () => {
    const md = formatPredictionTrackMarkdown(sampleStats());
    expect(md).toContain('## 📊 历史预测对错');
    expect(md).toContain('LLM 方向命中');
    expect(md).toContain('**70%**');
    expect(md).toContain('高分段');
    expect(md).toContain('最近预测明细');
    expect(md).toContain('2026-07-10');
    expect(md).toContain('✅');
    expect(md).toContain('顺/逆预测');
  });
});
