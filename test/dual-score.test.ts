import { describe, it, expect } from 'vitest';
import {
  evaluateDualScore,
  DUAL_CONFLICT_THRESHOLD,
  predictDirectionFromScore,
} from '../src/utils/dual-score';

describe('evaluateDualScore', () => {
  it('双分接近且同向 → aligned / both', () => {
    const v = evaluateDualScore(62, 58);
    expect(v.alignment).toBe('aligned');
    expect(v.actionPolicy).toBe('both');
    expect(v.actionOverride).toBeNull();
    expect(v.sameDirection).toBe(true);
  });

  it('偏差>15 → conflict / hold', () => {
    const v = evaluateDualScore(75, 40);
    expect(Math.abs(v.delta!)).toBeGreaterThan(DUAL_CONFLICT_THRESHOLD);
    expect(v.alignment).toBe('conflict');
    expect(v.actionPolicy).toBe('hold_on_conflict');
    expect(v.actionOverride?.action).toMatch(/定投/);
  });

  it('无量化 → llm_only', () => {
    const v = evaluateDualScore(60, null);
    expect(v.alignment).toBe('quant_missing');
    expect(v.actionPolicy).toBe('llm_only');
  });

  it('弱一致性 → hold', () => {
    const v = evaluateDualScore(55, 52, { consistencyWeak: true });
    expect(v.actionPolicy).toBe('hold_on_conflict');
  });

  it('数据红档 → hold 且覆盖', () => {
    const v = evaluateDualScore(70, 65, { dataActionable: false });
    expect(v.actionOverride).not.toBeNull();
  });
});

describe('predictDirectionFromScore', () => {
  it('边界', () => {
    expect(predictDirectionFromScore(56)).toBe('up');
    expect(predictDirectionFromScore(44)).toBe('down');
    expect(predictDirectionFromScore(50)).toBeNull();
  });
});
