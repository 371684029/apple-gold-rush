import { describe, it, expect } from 'vitest';
import { buildReliabilityCard } from '../src/utils/reliability-card.js';
import { archiveSearchRaw, toArchiveEntries } from '../src/utils/search-raw-archive.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('buildReliabilityCard', () => {
  it('绿档 + 对齐 + 强一致 → 较高可信度与较窄区间', () => {
    const c = buildReliabilityCard({
      llmScore: 62,
      direction: 'bullish',
      quantScore: 58,
      dataGate: { tier: 'green', actionable: true, overallConfidence: 75, banners: [] },
      dual: { alignment: 'aligned', delta: 4, actionPolicy: 'show_both', sameDirection: true },
      consistency: { level: 'strong', summary: '4/4 偏多', agreeCount: 4, totalCount: 4 },
      calibrationSampleSize: 22,
      calibrationBias: '中性',
      position: { targetPct: 65, label: '偏积极', emoji: '🟢', headline: '可偏积极', tilt: 'hold' },
      trackHitRate: 0.65,
      trackSampleSize: 20,
    });
    expect(c.score).toBeGreaterThanOrEqual(70);
    expect(c.tier).toBe('high');
    expect(c.scoreBand.high - c.scoreBand.low).toBeLessThanOrEqual(10);
    expect(c.tldr.line1).toContain('62');
    expect(c.tldr.line2).toContain('65%');
  });

  it('较昨日持平时 TL;DR 提示可跳过细读', () => {
    const c = buildReliabilityCard({
      llmScore: 55,
      direction: 'neutral',
      quantScore: 54,
      dataGate: { tier: 'green', actionable: true, overallConfidence: 72, banners: [] },
      dual: { alignment: 'aligned', delta: 1, actionPolicy: 'show_both', sameDirection: true },
      consistency: { level: 'strong', summary: '4/4', agreeCount: 4, totalCount: 4 },
      calibrationSampleSize: 15,
      position: { targetPct: 55, label: '标配', emoji: '🟡', headline: '维持', tilt: 'hold' },
      dayDelta: {
        skipFineRead: true,
        headline: '与昨日基本持平，可跳过细读',
        scoreDelta: 1,
        positionDelta: 0,
        driverSummary: '宏观驱动较昨日无明显数字变化',
        trackHint: null,
      },
    });
    expect(c.tldr.line1).toMatch(/可跳过细读/);
  });

  it('兼容百分数形式的 trackHitRate', () => {
    const c = buildReliabilityCard({
      llmScore: 60,
      dataGate: { tier: 'green', actionable: true, overallConfidence: 70, banners: [] },
      dual: { alignment: 'aligned', delta: 3, actionPolicy: 'show_both', sameDirection: true },
      consistency: { level: 'moderate', summary: '3/4', agreeCount: 3, totalCount: 4 },
      calibrationSampleSize: 12,
      trackHitRate: 65,
      trackSampleSize: 20,
    });
    expect(c.factors.find(f => f.name === '滚动命中')?.detail).toMatch(/65%/);
  });

  it('红档门禁 → blocked 且宽区间', () => {
    const c = buildReliabilityCard({
      llmScore: 55,
      dataGate: { tier: 'red', actionable: false, overallConfidence: 30, banners: [] },
      dual: { alignment: 'aligned', delta: 2, actionPolicy: 'show_both', sameDirection: true },
      consistency: { level: 'moderate', summary: '3/4', agreeCount: 3, totalCount: 4 },
      calibrationSampleSize: 3,
    });
    expect(c.tier).toBe('blocked');
    expect(c.warnings.some(w => /红档/.test(w))).toBe(true);
    expect(c.bandHalfWidth).toBeGreaterThanOrEqual(12);
  });

  it('双分冲突压低可信度', () => {
    const c = buildReliabilityCard({
      llmScore: 70,
      quantScore: 40,
      dataGate: { tier: 'green', actionable: true, overallConfidence: 70, banners: [] },
      dual: { alignment: 'conflict', delta: 30, actionPolicy: 'hold_on_conflict', sameDirection: false },
      consistency: { level: 'weak', summary: '分歧', agreeCount: 2, totalCount: 4 },
      calibrationSampleSize: 10,
    });
    expect(c.score).toBeLessThan(60);
    expect(c.warnings.some(w => /冲突|分歧/.test(w))).toBe(true);
  });
});

describe('search-raw-archive', () => {
  it('写入并 30 天外清理逻辑不抛错', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-search-raw-'));
    try {
      const entries = toArchiveEntries([
        {
          query: 'gold price',
          dataType: 'xauusd',
          results: [{ title: 't', url: 'https://example.com', snippet: 'Gold $2350', engine: 'tavily', sourceGrade: 'A' }],
        },
      ]);
      const p = archiveSearchRaw(entries, { dir, date: '2026-07-16', now: new Date('2026-07-16T12:00:00Z') });
      expect(p).toBeTruthy();
      expect(fs.existsSync(p!)).toBe(true);
      const j = JSON.parse(fs.readFileSync(p!, 'utf-8'));
      expect(j.queries.length).toBe(1);
      expect(j.queries[0].results[0].snippet).toContain('2350');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
