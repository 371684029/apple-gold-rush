import { describe, it, expect } from 'vitest';
import {
  listDualScores,
  synthesizeNeighborDelta,
  attachNeighborDeltas,
  renderListDualHtml,
  renderListDeltaHtml,
  fmtSigned,
} from '../web/list-card-meta.cjs';

describe('list-card-meta', () => {
  it('fmtSigned', () => {
    expect(fmtSigned(3)).toBe('+3');
    expect(fmtSigned(-2)).toBe('-2');
    expect(fmtSigned(0)).toBe('±0');
  });

  it('listDualScores 读 LLM/量化/冲突', () => {
    const d = listDualScores({
      score: 70,
      dualScore: { llm: 70, quant: 50, delta: 20, conflict: true },
      quantInfo: { quantScore: 50 },
    });
    expect(d.llm).toBe(70);
    expect(d.quant).toBe(50);
    expect(d.conflict).toBe(true);
    expect(renderListDualHtml(d, s => s)).toContain('LLM');
    expect(renderListDualHtml(d, s => s)).toContain('量化');
    expect(renderListDualHtml(d, s => s)).toContain('分歧');
  });

  it('相邻推算：分数跳变时有差分 headline', () => {
    const curr = { dateLabel: '2026-07-24', score: 62, quantInfo: { quantScore: 55 }, positionRec: { targetPct: 65 } };
    const prev = { dateLabel: '2026-07-23', score: 50, quantInfo: { quantScore: 52 }, positionRec: { targetPct: 50 } };
    const dd = synthesizeNeighborDelta(curr, prev);
    expect(dd.skipFineRead).toBe(false);
    expect(dd.scoreDelta).toBe(12);
    expect(dd.positionDelta).toBe(15);
    expect(dd.source).toBe('neighbor');
    expect(dd.headline).toMatch(/较2026-07-23/);
    expect(renderListDeltaHtml(dd, s => s)).toContain('分+12');
  });

  it('相邻推算：持平标记 skip', () => {
    const curr = { dateLabel: '07-24', score: 55, quantInfo: { quantScore: 54 }, positionRec: { targetPct: 55 } };
    const prev = { dateLabel: '07-23', score: 54, quantInfo: { quantScore: 54 }, positionRec: { targetPct: 55 } };
    const dd = synthesizeNeighborDelta(curr, prev);
    expect(dd.skipFineRead).toBe(true);
    expect(dd.headline).toMatch(/持平/);
  });

  it('attachNeighborDeltas：无 MD 时用相邻推算；有 MD 优先', () => {
    const rows = attachNeighborDeltas([
      {
        dateLabel: '2026-07-24',
        score: 60,
        quantInfo: { quantScore: 58 },
        dayDelta: { headline: 'MD头条', scoreDelta: 5, skipFineRead: false },
      },
      {
        dateLabel: '2026-07-23',
        score: 50,
        quantInfo: { quantScore: 52 },
        positionRec: { targetPct: 50 },
      },
      {
        dateLabel: '2026-07-22',
        score: 48,
        quantInfo: { quantScore: 50 },
        positionRec: { targetPct: 48 },
      },
    ]);
    expect(rows[0].listDelta.headline).toBe('MD头条');
    expect(rows[0].listDelta.source).toBe('md');
    expect(rows[1].listDelta.source).toBe('neighbor');
    expect(rows[1].listDelta.scoreDelta).toBe(2);
    expect(rows[2].listDelta).toBeNull(); // 最旧无上一日
  });
});
