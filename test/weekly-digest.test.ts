import { describe, it, expect } from 'vitest';
import { buildWeeklyDigest, formatDigestMarkdown } from '../src/utils/weekly-digest';
import type { AnalysisReportRow } from '../src/db/reports';

describe('buildWeeklyDigest', () => {
  it('空列表提示无数据', () => {
    const d = buildWeeklyDigest([], 7);
    expect(d.reportCount).toBe(0);
    expect(d.headline).toContain('暂无');
  });

  it('计算均分与跳变', () => {
    const reports: AnalysisReportRow[] = [
      { id: 1, date: '2026-06-01', horizon: 'all', reportJson: '{}', overallScore: 60, direction: 'neutral', quantScore: null, createdAt: '' },
      { id: 2, date: '2026-06-02', horizon: 'all', reportJson: '{}', overallScore: 70, direction: 'bullish', quantScore: null, createdAt: '' },
      { id: 3, date: '2026-06-03', horizon: 'all', reportJson: '{}', overallScore: 55, direction: 'neutral', quantScore: null, createdAt: '' },
    ];
    const d = buildWeeklyDigest(reports, 7);
    expect(d.avgScore).toBe(62);
    expect(Math.abs(d.largestSwing?.delta ?? 0)).toBe(15);
    expect(formatDigestMarkdown(d)).toContain('周期摘要');
  });
});
