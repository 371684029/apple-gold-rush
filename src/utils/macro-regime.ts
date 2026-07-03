// 金市宏观阶段标签 — 纯本地规则，不依赖 LLM

import type { MarketData } from '../types/market.js';

export interface MacroRegime {
  /** 机器可读标签 */
  tag: string;
  /** 中文展示名 */
  label: string;
  /** 一句话说明 */
  description: string;
  /** 判定依据 */
  signals: string[];
}

/**
 * 根据市场数据（+ 可选金价偏离 MA20%）判定当前宏观阶段。
 * 规则按优先级叠加，取得分最高者。
 */
export function detectMacroRegime(
  marketData: MarketData,
  goldDeviationPct: number | null = null,
): MacroRegime {
  const tips = marketData.usTreasury?.tips?.value ?? null;
  const dxyChange = marketData.dollarIndex?.value?.change ?? 0;
  const yield10y = marketData.usTreasury?.yield10y?.value ?? null;

  const candidates: Array<{ score: number; regime: MacroRegime }> = [];

  if (tips != null && tips >= 2.0) {
    candidates.push({
      score: 30 + tips,
      regime: {
        tag: 'real_rate_headwind',
        label: '实际利率压制',
        description: 'TIPS 实际利率偏高，持有黄金机会成本上升，反弹易遇阻。',
        signals: [`TIPS ${tips.toFixed(2)}% ≥ 2.0%`],
      },
    });
  }

  if (tips != null && tips < 1.5 && dxyChange < -0.2) {
    candidates.push({
      score: 28,
      regime: {
        tag: 'dovish_pivot_watch',
        label: '降息预期升温',
        description: '实际利率偏低且美元走弱，利于黄金估值修复。',
        signals: [`TIPS ${tips.toFixed(2)}%`, `美元 ${dxyChange > 0 ? '+' : ''}${dxyChange.toFixed(2)}%`],
      },
    });
  }

  if (dxyChange > 0.4) {
    candidates.push({
      score: 22 + Math.abs(dxyChange),
      regime: {
        tag: 'dollar_strength',
        label: '美元走强段',
        description: '美元指数上行压制以美元计价的黄金，需关注反弹持续性。',
        signals: [`美元 ${dxyChange > 0 ? '+' : ''}${dxyChange.toFixed(2)}%`],
      },
    });
  }

  if (goldDeviationPct != null && goldDeviationPct <= -5) {
    candidates.push({
      score: 25 + Math.abs(goldDeviationPct),
      regime: {
        tag: 'oversold_repair',
        label: '超卖修复段',
        description: '金价显著低于 MA20，技术性反弹概率上升，但趋势未必反转。',
        signals: [`偏离 MA20 ${goldDeviationPct.toFixed(1)}%`],
      },
    });
  }

  if (goldDeviationPct != null && goldDeviationPct >= 8) {
    candidates.push({
      score: 20 + goldDeviationPct,
      regime: {
        tag: 'extended_rally',
        label: '偏离过热段',
        description: '金价显著高于 MA20，追高风险上升，定投宜控节奏。',
        signals: [`偏离 MA20 +${goldDeviationPct.toFixed(1)}%`],
      },
    });
  }

  if (yield10y != null && yield10y >= 4.5 && tips != null && tips >= 1.8) {
    candidates.push({
      score: 18,
      regime: {
        tag: 'rate_volatility',
        label: '利率高位震荡',
        description: '名义与实际利率均处偏高位，黄金方向取决于数据与联储预期。',
        signals: [`10Y ${yield10y.toFixed(2)}%`, tips != null ? `TIPS ${tips.toFixed(2)}%` : ''].filter(Boolean),
      },
    });
  }

  if (candidates.length === 0) {
    return {
      tag: 'range_bound',
      label: '震荡整理',
      description: '宏观信号未形成单一主导因素，宜区间思维、定投纪律为主。',
      signals: ['美元/TIPS/偏离度均未触发极端阈值'],
    };
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].regime;
}

/** CLI / Markdown 单行 */
export function formatMacroRegimeLine(regime: MacroRegime): string {
  return `${regime.label}（${regime.tag}）— ${regime.description}`;
}
