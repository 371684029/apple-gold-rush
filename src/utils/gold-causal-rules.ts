// 黄金市场因果规则库 — 本地匹配，减少 LLM 幻觉

import type { MarketData } from '../types/market.js';
import type { MacroRegime } from './macro-regime.js';

export interface CausalChainMatch {
  ruleId: string;
  cause: string;
  effect: string;
  confidence: number;
  conditions: string[];
  counterConditions: string[];
  applicable: boolean;
  note: string;
}

interface CausalRule {
  id: string;
  cause: string;
  effect: string;
  confidence: number;
  conditions: string[];
  counterConditions: string[];
  test: (ctx: { market: MarketData; regime: MacroRegime; goldDeviation: number | null }) => boolean;
}

const RULES: CausalRule[] = [
  {
    id: 'dxy_down_gold_up',
    cause: '美元指数走弱',
    effect: '黄金利多（美元计价资产吸引力上升）',
    confidence: 0.85,
    conditions: ['通胀预期稳定或下行', '地缘风险未极端升级'],
    counterConditions: ['通胀预期同步大幅上行', '实际利率逆势走高'],
    test: ({ market }) => (market.dollarIndex?.value?.change ?? 0) < -0.3,
  },
  {
    id: 'dxy_up_gold_down',
    cause: '美元指数走强',
    effect: '黄金利空（持有成本与替代资产吸引力上升）',
    confidence: 0.82,
    conditions: ['无极端避险买盘'],
    counterConditions: ['地缘危机升级导致美元黄金同涨'],
    test: ({ market }) => (market.dollarIndex?.value?.change ?? 0) > 0.4,
  },
  {
    id: 'tips_up_gold_down',
    cause: '实际利率（TIPS）上行',
    effect: '黄金利空（无息资产机会成本上升）',
    confidence: 0.88,
    conditions: ['联储偏鹰或通胀回落慢于利率'],
    counterConditions: ['通胀上行更快于名义利率'],
    test: ({ market }) => (market.usTreasury?.tips?.value ?? 0) >= 2.0,
  },
  {
    id: 'tips_low_dxy_weak',
    cause: '实际利率偏低 + 美元走弱',
    effect: '黄金估值修复概率上升',
    confidence: 0.8,
    conditions: ['降息预期未大幅回撤'],
    counterConditions: ['风险事件引发流动性挤兑'],
    test: ({ market }) => {
      const tips = market.usTreasury?.tips?.value;
      const dxy = market.dollarIndex?.value?.change ?? 0;
      return tips != null && tips < 1.5 && dxy < -0.2;
    },
  },
  {
    id: 'oversold_bounce',
    cause: '金价显著低于 MA20（超卖）',
    effect: '技术性反弹概率上升（趋势未必反转）',
    confidence: 0.65,
    conditions: ['未伴随流动性危机'],
    counterConditions: ['周线空头结构完好且宏观逆风'],
    test: ({ goldDeviation }) => goldDeviation != null && goldDeviation <= -5,
  },
  {
    id: 'extended_pullback',
    cause: '金价显著高于 MA20（过热）',
    effect: '回调/震荡概率上升',
    confidence: 0.7,
    conditions: ['追涨资金拥挤'],
    counterConditions: ['避险买盘持续涌入'],
    test: ({ goldDeviation }) => goldDeviation != null && goldDeviation >= 8,
  },
  {
    id: 'real_rate_regime',
    cause: '宏观阶段：实际利率压制',
    effect: '反弹易遇阻，定投宜控节奏',
    confidence: 0.75,
    conditions: ['TIPS ≥ 2%'],
    counterConditions: ['联储意外转鸽'],
    test: ({ regime }) => regime.tag === 'real_rate_headwind',
  },
];

/** 匹配当前市场适用的因果链（最多 5 条） */
export function matchCausalChains(
  market: MarketData,
  regime: MacroRegime,
  goldDeviation: number | null,
  max = 5,
): CausalChainMatch[] {
  const ctx = { market, regime, goldDeviation };
  const matches: CausalChainMatch[] = [];

  for (const rule of RULES) {
    if (!rule.test(ctx)) continue;
    matches.push({
      ruleId: rule.id,
      cause: rule.cause,
      effect: rule.effect,
      confidence: rule.confidence,
      conditions: rule.conditions,
      counterConditions: rule.counterConditions,
      applicable: true,
      note: `规则 ${rule.id} 命中当前市场信号`,
    });
    if (matches.length >= max) break;
  }

  if (matches.length === 0) {
    matches.push({
      ruleId: 'no_strong_rule',
      cause: '宏观信号分散',
      effect: '暂无单一主导因果链，宜区间思维',
      confidence: 0.5,
      conditions: ['多因素拉锯'],
      counterConditions: [],
      applicable: false,
      note: '未命中预置高置信规则，以多维度综合研判为主',
    });
  }

  return matches;
}

export function formatCausalChainsConsole(chains: CausalChainMatch[], indent = '  '): string {
  const lines = [`${indent}🔗 因果链（本地规则匹配）`];
  for (const c of chains) {
    lines.push(`${indent}  · ${c.cause} → ${c.effect}（置信 ${(c.confidence * 100).toFixed(0)}%）`);
    if (c.conditions.length) lines.push(`${indent}    条件：${c.conditions.join('；')}`);
    if (c.counterConditions.length) lines.push(`${indent}    反例：${c.counterConditions.join('；')}`);
  }
  return lines.join('\n');
}

export function formatCausalChainsMarkdown(chains: CausalChainMatch[]): string[] {
  const lines = ['## 🔗 因果链（本地规则）', ''];
  for (const c of chains) {
    lines.push(`- **${c.cause}** → ${c.effect}（置信 ${(c.confidence * 100).toFixed(0)}%）`);
    if (c.conditions.length) lines.push(`  - 条件：${c.conditions.join('；')}`);
    if (c.counterConditions.length) lines.push(`  - 反例：${c.counterConditions.join('；')}`);
  }
  lines.push('');
  return lines;
}
