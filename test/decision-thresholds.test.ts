import { describe, it, expect } from 'vitest';
import {
  directionFromScore,
  predictDirectionFromScore,
  classifyReturn,
  isHit,
  wilsonInterval,
  beatsBaseline,
  formatHitRate,
  FLAT_RETURN_PCT,
  MIN_HITRATE_SAMPLE,
} from '../src/utils/decision-thresholds.js';

describe('方向判定', () => {
  it('展示方向与记账方向同源', () => {
    for (let s = 0; s <= 100; s++) {
      const shown = directionFromScore(s);
      const graded = predictDirectionFromScore(s);
      if (shown === 'bullish') expect(graded).toBe('up');
      else if (shown === 'bearish') expect(graded).toBe('down');
      else expect(graded).toBeNull();
    }
  });
});

describe('涨跌分类死区', () => {
  it('死区内记持平', () => {
    expect(classifyReturn(0)).toBe('flat');
    expect(classifyReturn(FLAT_RETURN_PCT)).toBe('flat');
    expect(classifyReturn(-FLAT_RETURN_PCT)).toBe('flat');
  });

  it('死区外按方向记账', () => {
    expect(classifyReturn(FLAT_RETURN_PCT + 0.01)).toBe('up');
    expect(classifyReturn(-FLAT_RETURN_PCT - 0.01)).toBe('down');
  });
});

describe('命中判定', () => {
  it('方向一致记命中', () => {
    expect(isHit('up', 1.5)).toBe(true);
    expect(isHit('down', -1.5)).toBe(true);
  });

  it('方向相反记未命中', () => {
    expect(isHit('up', -1.5)).toBe(false);
    expect(isHit('down', 1.5)).toBe(false);
  });

  it('持平日与无预测日不计对错', () => {
    expect(isHit('up', 0.05)).toBeNull();
    expect(isHit(null, 1.5)).toBeNull();
    expect(isHit('up', null)).toBeNull();
  });
});

describe('Wilson 置信区间', () => {
  it('区间包含点估计', () => {
    const [lo, hi] = wilsonInterval(7, 10);
    expect(lo).toBeLessThan(0.7);
    expect(hi).toBeGreaterThan(0.7);
  });

  it('样本越大区间越窄', () => {
    const [lo1, hi1] = wilsonInterval(7, 10);
    const [lo2, hi2] = wilsonInterval(70, 100);
    expect(hi2 - lo2).toBeLessThan(hi1 - lo1);
  });

  it('零样本退化为全区间', () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
  });
});

describe('基准比较', () => {
  it('小样本不认定跑赢，哪怕命中率很高', () => {
    expect(beatsBaseline(5, 5)).toBe(false);
    expect(beatsBaseline(MIN_HITRATE_SAMPLE - 1, MIN_HITRATE_SAMPLE - 1)).toBe(false);
  });

  it('7/10 不足以显著优于抛硬币', () => {
    expect(beatsBaseline(7, 10)).toBe(false);
  });

  it('70/100 显著优于抛硬币', () => {
    expect(beatsBaseline(70, 100)).toBe(true);
  });

  it('长期多头基准更高时判定更严格', () => {
    expect(beatsBaseline(60, 100, 0.5)).toBe(true);
    expect(beatsBaseline(60, 100, 0.65)).toBe(false);
  });
});

describe('命中率文案', () => {
  it('样本不足时明说不具统计意义', () => {
    const s = formatHitRate(6, MIN_HITRATE_SAMPLE - 1);
    expect(s).toContain('样本不足');
  });

  it('刚够样本量时给出区间而非结论式百分比', () => {
    const s = formatHitRate(7, MIN_HITRATE_SAMPLE);
    expect(s).toContain('95%CI');
    expect(s).toContain('无显著差异');
  });

  it('样本充足时给出置信区间与基准结论', () => {
    const s = formatHitRate(70, 100);
    expect(s).toContain('95%CI');
    expect(s).toContain('显著');
  });

  it('零样本不报百分比', () => {
    expect(formatHitRate(0, 0)).toContain('样本不足');
  });
});
