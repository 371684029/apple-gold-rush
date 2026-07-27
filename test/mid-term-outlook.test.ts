import { describe, it, expect } from 'vitest';
import {
  buildMidTermOutlook,
  formatMidTermOutlookMarkdown,
  formatMidTermOutlookConsole,
  MID_TERM_WEIGHTS,
  type MidTermOutlookInput,
} from '../src/utils/mid-term-outlook.js';
import type { InstitutionalSignal } from '../src/types/institutional.js';

function series(n: number, start: number, stepPct: number): number[] {
  const out: number[] = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + stepPct / 100));
  return out;
}

function flow(score: number): InstitutionalSignal {
  return { overallScore: score } as InstitutionalSignal;
}

/** 各因子齐备的偏多输入：上涨趋势 + 实际利率下行 + 美元走弱 */
function bullishInput(): MidTermOutlookInput {
  return {
    closes: series(260, 2400, 0.08),
    tips: series(120, 2.2, -0.25),
    dxy: series(120, 108, -0.03),
    cftcNetPercentile: 45,
    flowSignal: flow(65),
  };
}

/** 各因子齐备的偏空输入 */
function bearishInput(): MidTermOutlookInput {
  return {
    closes: series(260, 3600, -0.08),
    tips: series(120, 1.2, 0.35),
    dxy: series(120, 96, 0.04),
    cftcNetPercentile: 60,
    flowSignal: flow(35),
  };
}

describe('权重设定', () => {
  it('MID_TERM_WEIGHTS 合计为 1.0', () => {
    const sum = Object.values(MID_TERM_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });
});

describe('方向判定', () => {
  it('趋势向上 + 实际利率下行 + 美元走弱 → 中期偏多', () => {
    // 估值分位是反向因子，上涨趋势会把它压到低分，因此综合分不会冲得很高
    const r = buildMidTermOutlook(bullishInput());
    expect(r.score).toBeGreaterThanOrEqual(58);
    expect(r.direction).toBe('bullish');
  });

  it('趋势向下 + 实际利率上行 + 美元走强 → 中期偏空', () => {
    const r = buildMidTermOutlook(bearishInput());
    expect(r.score).toBeLessThan(42);
    expect(r.direction).toBe('bearish');
  });

  it('同时给出 1 个月与 3 个月两档', () => {
    const r = buildMidTermOutlook(bullishInput());
    expect(r.horizons.map(h => h.months)).toEqual([1, 3]);
    for (const h of r.horizons) {
      expect(h.action).toBeTruthy();
      expect(h.biasScore).toBeGreaterThanOrEqual(0);
      expect(h.biasScore).toBeLessThanOrEqual(100);
    }
  });
});

describe('覆盖度重归一', () => {
  it('只有价格序列时仍给出可用分数而非被拉低', () => {
    const r = buildMidTermOutlook({ closes: series(260, 3000, 0) });
    expect(r.coverage).toBeLessThan(1);
    expect(r.coverage).toBeGreaterThan(0);
    // 走平行情不应因为缺宏观数据被算成偏空
    expect(r.score).toBeGreaterThanOrEqual(40);
    expect(r.score).toBeLessThanOrEqual(60);
  });

  it('生效因子实际权重合计为 1', () => {
    const r = buildMidTermOutlook(bullishInput());
    const eff = Object.values(r.factors).reduce((a, f) => a + f.effectiveWeight, 0);
    expect(eff).toBeCloseTo(1, 2);
  });

  it('覆盖度过低时置信降级并给出保守结论', () => {
    const r = buildMidTermOutlook({ closes: series(80, 3000, 0.05) });
    if (r.coverage < 0.6) {
      expect(r.summary).toContain('参考价值有限');
      expect(r.horizons.every(h => h.confidence === 'low')).toBe(true);
    }
  });

  it('样本不足 60 日时不产出趋势/估值因子', () => {
    const r = buildMidTermOutlook({ closes: series(30, 3000, 0.1) });
    expect(r.factors.trend_structure).toBeUndefined();
    expect(r.factors.valuation).toBeUndefined();
  });
});

describe('持仓拥挤度反向逻辑', () => {
  it('极端拥挤给出偏空信号', () => {
    const r = buildMidTermOutlook({ ...bullishInput(), cftcNetPercentile: 92 });
    expect(r.factors.positioning.normalizedScore).toBeLessThan(50);
    expect(r.factors.positioning.note).toContain('拥挤');
  });

  it('仓位出清给出偏多信号', () => {
    const r = buildMidTermOutlook({ ...bullishInput(), cftcNetPercentile: 8 });
    expect(r.factors.positioning.normalizedScore).toBeGreaterThan(50);
  });

  it('中间区间接近中性', () => {
    const r = buildMidTermOutlook({ ...bullishInput(), cftcNetPercentile: 50 });
    expect(Math.abs(r.factors.positioning.normalizedScore - 50)).toBeLessThanOrEqual(5);
  });
});

describe('实际利率趋势看方向而非水平', () => {
  it('高水平但持续下行仍偏多', () => {
    const r = buildMidTermOutlook({ closes: series(260, 3000, 0), tips: series(120, 2.5, -0.3) });
    expect(r.factors.real_rate_trend.normalizedScore).toBeGreaterThan(50);
    expect(r.factors.real_rate_trend.note).toContain('利多');
  });

  it('低水平但持续上行仍偏空', () => {
    const r = buildMidTermOutlook({ closes: series(260, 3000, 0), tips: series(120, 0.5, 0.5) });
    expect(r.factors.real_rate_trend.normalizedScore).toBeLessThan(50);
    expect(r.factors.real_rate_trend.note).toContain('利空');
  });
});

describe('平滑防抖', () => {
  it('相对上一期的跳变有上限', () => {
    const previous = buildMidTermOutlook(bearishInput());
    const now = buildMidTermOutlook({ ...bullishInput(), previous });
    expect(Math.abs(now.score - previous.score)).toBeLessThanOrEqual(6);
  });

  it('无上一期时不做平滑', () => {
    const a = buildMidTermOutlook(bullishInput());
    const b = buildMidTermOutlook({ ...bullishInput(), previous: null });
    expect(a.score).toBe(b.score);
  });
});

describe('可解释输出', () => {
  it('给出驱动与推翻条件', () => {
    const r = buildMidTermOutlook(bullishInput());
    expect(r.drivers.length).toBeGreaterThan(0);
    expect(r.watchTriggers.length).toBeGreaterThan(0);
    expect(r.watchTriggers.join(' ')).toContain('实际利率');
  });

  it('Markdown 含期限表、因子表与推翻条件', () => {
    const md = formatMidTermOutlookMarkdown(buildMidTermOutlook(bullishInput()));
    expect(md).toContain('## 🧭 中期方向预期（1～3 个月）');
    expect(md).toContain('1 个月');
    expect(md).toContain('3 个月');
    expect(md).toContain('中期因子构成');
    expect(md).toContain('什么情况下推翻这个中期判断');
    expect(md).toContain('20 个交易日');
  });

  it('Console 输出含两档与驱动', () => {
    const s = formatMidTermOutlookConsole(buildMidTermOutlook(bullishInput()));
    expect(s).toContain('中期方向预期');
    expect(s).toContain('1 个月');
    expect(s).toContain('主要驱动');
  });
});

describe('与短期分刻意解耦', () => {
  it('不消费 RSI/MACD 等日线动能，仅结构量', () => {
    const keys = Object.keys(MID_TERM_WEIGHTS);
    expect(keys).not.toContain('rsi');
    expect(keys).not.toContain('macd');
    expect(keys).not.toContain('bollinger');
  });

  it('单日暴涨不足以翻转中期方向', () => {
    const base = bearishInput();
    const spiked = { ...base, closes: [...base.closes.slice(0, -1), base.closes[base.closes.length - 1] * 1.05] };
    const r = buildMidTermOutlook(spiked);
    expect(r.direction).toBe('bearish');
  });
});
