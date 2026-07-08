// 长期方向预期 — 1/3/5 年（纯本地规则，基于当日四维度 + 宏观阶段）

import type {
  Direction,
  FundamentalAnalysis,
  LongTermHorizonOutlook,
  LongTermHorizonYears,
  LongTermOutlook,
  RebuttalAnalysis,
  SentimentAnalysis,
  TechnicalAnalysis,
} from '../types/analysis.js';
import type { MacroRegime } from './macro-regime.js';
import type { GoldPriceRecord } from '../types/market.js';
import {
  filterBandsByDirectionHint,
  enrichReturnBandWithHistory,
} from './long-term-backtest.js';

export interface LongTermOutlookInput {
  technical: TechnicalAnalysis;
  fundamental: FundamentalAnalysis;
  sentiment: SentimentAnalysis;
  rebuttal: RebuttalAnalysis;
  overallScore: number;
  overallDirection: Direction;
  macroRegime: MacroRegime;
  /** 可选：本地金价历史，用于回报带历史分位数 */
  priceHistory?: GoldPriceRecord[];
}

const HORIZONS: LongTermHorizonYears[] = [1, 3, 5];

/** 各期限维度权重（技术/基本面/情绪/宏观） */
const WEIGHTS: Record<LongTermHorizonYears, [number, number, number, number]> = {
  1: [0.25, 0.35, 0.25, 0.15],
  3: [0.10, 0.35, 0.35, 0.20],
  5: [0.05, 0.30, 0.40, 0.25],
};

function directionBias(score: number, direction: Direction): number {
  const adj = direction === 'bullish' ? 8 : direction === 'bearish' ? -8 : 0;
  return Math.max(0, Math.min(100, score + adj));
}

function macroBias(regime: MacroRegime): number {
  const map: Record<string, number> = {
    real_rate_headwind: 38,
    dollar_strength: 40,
    risk_off_bid: 72,
    dovish_pivot_watch: 68,
    range_bound: 50,
    inflation_hedge: 62,
    oversold_repair: 58,
    extended_rally: 45,
    rate_volatility: 48,
    unknown: 50,
  };
  return map[regime.tag] ?? 50;
}

function rebuttalPenalty(rebuttal: RebuttalAnalysis, years: LongTermHorizonYears): number {
  const bear = rebuttal.bearScore ?? 50;
  const strength = rebuttal.rebuttalStrength === 'strong' ? 1.2 : rebuttal.rebuttalStrength === 'moderate' ? 1 : 0.7;
  const horizonFactor = years === 1 ? 1 : years === 3 ? 0.7 : 0.5;
  return ((bear - 50) / 50) * 12 * strength * horizonFactor;
}

function scoreToDirection(bias: number): Direction {
  if (bias >= 58) return 'bullish';
  if (bias <= 42) return 'bearish';
  return 'neutral';
}

function trendLabel(direction: Direction, bias: number): string {
  if (direction === 'bullish') {
    return bias >= 70 ? '偏强上行' : '温和上行';
  }
  if (direction === 'bearish') {
    return bias <= 30 ? '偏弱下行' : '温和下行';
  }
  return '宽幅震荡';
}

function returnBand(direction: Direction, bias: number, years: LongTermHorizonYears): string {
  const spread = direction === 'neutral' ? 8 : 12;
  const mid = direction === 'bullish'
    ? 6 + (bias - 50) * 0.35 * years
    : direction === 'bearish'
      ? -6 - (50 - bias) * 0.35 * years
      : (bias - 50) * 0.15 * years;
  const lo = Math.round((mid - spread) * 10) / 10;
  const hi = Math.round((mid + spread) * 10) / 10;
  const sign = lo >= 0 ? '+' : '';
  return `名义累计约 ${sign}${lo}% ~ ${hi >= 0 ? '+' : ''}${hi}%（${years}年，非承诺）`;
}

function confidence(bias: number, rebuttal: RebuttalAnalysis): 'low' | 'moderate' | 'high' {
  const spread = Math.abs(bias - 50);
  if (rebuttal.rebuttalStrength === 'strong' && rebuttal.bearScore >= 60) return 'low';
  if (spread >= 18) return 'high';
  if (spread >= 10) return 'moderate';
  return 'low';
}

function dcaAdvice(direction: Direction, years: LongTermHorizonYears): string {
  if (years >= 5) {
    if (direction === 'bullish') return '维持定投纪律；大跌分批加码，避免追涨一次性重仓';
    if (direction === 'bearish') return '可维持基础定投但放慢节奏；保留现金应对深度回调';
    return '标准定投 + 估值低位（偏离 MA 下方）适度加码';
  }
  if (direction === 'bullish') return '维持定投；急跌可小幅加码，高位不追';
  if (direction === 'bearish') return '放慢定投或暂停加码；等待评分/估值回落再恢复';
  return '维持基础定投，按日历执行，少做择时';
}

function pickDrivers(input: LongTermOutlookInput, years: LongTermHorizonYears): string[] {
  const drivers: string[] = [];
  if (years <= 3 && input.fundamental.fedStance) {
    drivers.push(`美联储立场：${input.fundamental.fedStance.slice(0, 40)}`);
  }
  if (input.fundamental.dollarIndexEffect) {
    drivers.push(`美元：${input.fundamental.dollarIndexEffect.slice(0, 36)}`);
  }
  if (years >= 3 && input.sentiment.centralBanks) {
    drivers.push(`央行/官方储备：${input.sentiment.centralBanks.slice(0, 36)}`);
  }
  if (input.sentiment.etfFlows) {
    drivers.push(`ETF 资金流：${input.sentiment.etfFlows.slice(0, 36)}`);
  }
  drivers.push(`宏观阶段：${input.macroRegime.label}`);
  if (years === 1 && input.technical.summary) {
    drivers.push(`技术趋势：${input.technical.summary.slice(0, 36)}`);
  }
  return drivers.slice(0, 4);
}

function pickRisks(input: LongTermOutlookInput): string[] {
  const risks: string[] = [];
  for (const p of (input.rebuttal.bearPoints ?? []).slice(0, 2)) {
    risks.push(p.point.slice(0, 48));
  }
  for (const t of (input.rebuttal.tailRisks ?? []).slice(0, 1)) {
    risks.push(`${t.risk}（${t.probability}%）`);
  }
  if (input.macroRegime.tag === 'real_rate_headwind') {
    risks.push('实际利率长期偏高压制金价');
  }
  if (risks.length === 0) risks.push('地缘与流动性冲击可能导致短期大幅波动');
  return risks.slice(0, 3);
}

function buildHorizon(input: LongTermOutlookInput, years: LongTermHorizonYears): LongTermHorizonOutlook {
  const [wT, wF, wS, wM] = WEIGHTS[years];
  const tech = directionBias(input.technical.score, input.technical.direction);
  const fund = directionBias(input.fundamental.score, input.fundamental.direction);
  const sent = directionBias(input.sentiment.score, input.sentiment.direction);
  const macro = macroBias(input.macroRegime);
  const overall = directionBias(input.overallScore, input.overallDirection);

  let bias = tech * wT + fund * wF + sent * wS + macro * wM;
  bias = bias * 0.85 + overall * 0.15;
  bias -= rebuttalPenalty(input.rebuttal, years);
  bias = Math.max(5, Math.min(95, Math.round(bias)));

  const direction = scoreToDirection(bias);
  let returnBandStr = returnBand(direction, bias, years);
  if (input.priceHistory?.length) {
    const hist = filterBandsByDirectionHint(input.priceHistory, direction, years);
    returnBandStr = enrichReturnBandWithHistory(returnBandStr, hist);
  }
  return {
    years,
    label: `${years}年`,
    direction,
    biasScore: bias,
    confidence: confidence(bias, input.rebuttal),
    trendLabel: trendLabel(direction, bias),
    returnBand: returnBandStr,
    drivers: pickDrivers(input, years),
    risks: pickRisks(input),
    dcaAdvice: dcaAdvice(direction, years),
  };
}

/** 构建 1/3/5 年长期方向预期 */
export function buildLongTermOutlook(input: LongTermOutlookInput): LongTermOutlook {
  const horizons = HORIZONS.map(y => buildHorizon(input, y));
  const bullishCount = horizons.filter(h => h.direction === 'bullish').length;
  const bearishCount = horizons.filter(h => h.direction === 'bearish').length;

  let summary: string;
  if (bullishCount >= 2) {
    summary = '中长期结构偏多：实际利率、央行购金与避险需求对黄金相对友好，短期波动不改长期配置价值。';
  } else if (bearishCount >= 2) {
    summary = '多期限共振偏空：美元/实际利率等逆风占主导，定投宜放慢节奏、等待更好风险收益比。';
  } else {
    summary = '期限分化：近端受宏观与技术面扰动，远端仍受结构性买盘支撑，宜纪律定投、少追涨杀跌。';
  }

  return {
    summary,
    horizons,
    disclaimer: '以上为研究框架下的方向性预期，非精确预测或投资建议；黄金波动大，请控制仓位与节奏。',
  };
}

export function formatLongTermOutlookConsole(outlook: LongTermOutlook, indent = '  '): string {
  const lines: string[] = [
    `${indent}🔭 长期方向预期（1 / 3 / 5 年）`,
    `${indent}${outlook.summary}`,
    '',
  ];
  for (const h of outlook.horizons) {
    const dir = h.direction === 'bullish' ? '📈 偏多' : h.direction === 'bearish' ? '📉 偏空' : '➡️ 中性';
    lines.push(`${indent}  ${h.label}  ${dir} · ${h.trendLabel} · 强度 ${h.biasScore}/100 · 置信 ${h.confidence}`);
    lines.push(`${indent}      ${h.returnBand}`);
    lines.push(`${indent}      定投：${h.dcaAdvice}`);
  }
  lines.push(`${indent}  ⚠️ ${outlook.disclaimer}`);
  return lines.join('\n');
}

export function formatLongTermOutlookMarkdown(outlook: LongTermOutlook): string {
  const lines: string[] = [
    '## 🔭 长期方向预期（1 / 3 / 5 年）',
    '',
    outlook.summary,
    '',
    '| 期限 | 方向 | 趋势 | 强度 | 置信度 | 名义回报区间（累计） |',
    '|------|------|------|------|--------|---------------------|',
  ];
  for (const h of outlook.horizons) {
    const dir = h.direction === 'bullish' ? '偏多' : h.direction === 'bearish' ? '偏空' : '中性';
    lines.push(`| ${h.label} | ${dir} | ${h.trendLabel} | ${h.biasScore} | ${h.confidence} | ${h.returnBand.replace(/\|/g, '/')} |`);
  }
  lines.push('');
  for (const h of outlook.horizons) {
    lines.push(`### ${h.label}`);
    lines.push('');
    lines.push(`- **驱动**：${h.drivers.join('；')}`);
    lines.push(`- **风险**：${h.risks.join('；')}`);
    lines.push(`- **定投建议**：${h.dcaAdvice}`);
    lines.push('');
  }
  lines.push(`> ${outlook.disclaimer}`);
  lines.push('');
  return lines.join('\n');
}
