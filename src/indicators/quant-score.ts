// 纯量化评分引擎 — deterministic, zero LLM, 100% reproducible
//
// 因子体系（12 类，当前启用 11 类）：
//   金价趋势 + RSI + MACD + 布林带 + 估值 + 主力动向
//   + 美元指数 + 名义收益率 + 实际收益率(TIPS) + 波动率 + 宏观阶段
//   + 事件热度（默认关闭，需 Tavily 数据）
// 所有因子均来自本地数据或确定性计算，与 LLM 打分完全独立。

import { latestRSI } from './rsi.js';
import { latestMACD } from './macd.js';
import { latestBollinger } from './bollinger.js';
import { latestMA } from './ma.js';
import { percentile } from './percentile.js';
import type { InstitutionalSignal } from '../types/institutional.js';

// ============================================================
// Types
// ============================================================

export interface QuantFactorDetail {
  name: string;
  rawValue: number;
  normalizedScore: number;
  weight: number;
  contribution: number;
}

export interface QuantScoreParams {
  closes: number[];
  dxy?: number[];
  us10y?: number[];
  tips?: number[];
  flowSignal?: InstitutionalSignal;
  regimeTag?: string;
  eventScore?: number;
}

export interface QuantScoreResult {
  score: number;
  direction: 'bullish' | 'bearish' | 'neutral';
  factors: Record<string, QuantFactorDetail>;
}

// ============================================================
// 权重（总和 = 1.0）
// ============================================================

const DEFAULT_WEIGHTS: Record<string, number> = {
  trend:     0.12,
  rsi:       0.10,
  macd:      0.10,
  bollinger: 0.05,
  valuation: 0.08,
  flow:      0.15,
  dxy:       0.12,
  us10y:     0.08,
  tips:      0.10,
  volatility:0.05,
  regime:    0.05,
  event_heat:0.00,
};

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function w(key: string): number { return DEFAULT_WEIGHTS[key] ?? 0; }

// ============================================================
// 因子 1-6：金价技术/估值/资金
// ============================================================

function trendFactor(closes: number[]): QuantFactorDetail {
  const ma = latestMA(closes, 20);
  const cur = closes[closes.length - 1];
  const dev = ma != null && ma > 0 ? ((cur - ma) / ma) * 100 : 0;
  return { name:'金价趋势(MA20)', rawValue:Math.round(dev*100)/100, normalizedScore:clamp(50+dev*5,10,90), weight:w('trend'), contribution:0 };
}

function rsiFactor(closes: number[]): QuantFactorDetail {
  const raw = latestRSI(closes, 14) ?? 50;
  return { name:'RSI(14)', rawValue:Math.round(raw*10)/10, normalizedScore:clamp(raw,5,95), weight:w('rsi'), contribution:0 };
}

function macdFactor(closes: number[]): QuantFactorDetail {
  const m = latestMACD(closes);
  const raw = m?.histogram ?? 0;
  const cur = closes[closes.length - 1];
  const scaled = cur > 0 ? (raw / cur) * 1000 : 0;
  return { name:'MACD动能', rawValue:Math.round(scaled*100)/100, normalizedScore:clamp(50+scaled*5,10,90), weight:w('macd'), contribution:0 };
}

function bollingerFactor(closes: number[]): QuantFactorDetail {
  const bb = latestBollinger(closes, 20, 2);
  const pB = bb?.percentB ?? 0.5;
  return { name:'布林带(%B)', rawValue:Math.round(pB*1000)/1000, normalizedScore:clamp((1-pB)*100,10,90), weight:w('bollinger'), contribution:0 };
}

function valuationFactor(closes: number[]): QuantFactorDetail {
  const cur = closes[closes.length - 1];
  const pct = closes.length >= 20 ? percentile(cur, closes) : 50;
  return { name:'估值(百分位)', rawValue:Math.round(pct*10)/10, normalizedScore:clamp(100-pct,10,90), weight:w('valuation'), contribution:0 };
}

function flowFactor(flowSignal?: InstitutionalSignal): QuantFactorDetail {
  const raw = flowSignal?.overallScore ?? 50;
  return { name:'主力(CFTC+ETF+央行)', rawValue:raw, normalizedScore:clamp(raw,10,90), weight:w('flow'), contribution:0 };
}

// ============================================================
// 因子 7-9：跨资产（美元、名义利率、实际利率）
// ============================================================

function dxyFactor(dxy: number[]): QuantFactorDetail {
  const ma = latestMA(dxy, 20);
  const cur = dxy[dxy.length - 1];
  const dev = ma != null && ma > 0 ? ((cur - ma) / ma) * 100 : 0;
  return { name:'美元指数(DXY)', rawValue:Math.round(dev*100)/100, normalizedScore:clamp(50-dev*10,10,90), weight:w('dxy'), contribution:0 };
}

function us10yFactor(us10y: number[]): QuantFactorDetail {
  const ma = latestMA(us10y, 20);
  const cur = us10y[us10y.length - 1];
  const base = ma ?? cur;
  const dev = base > 0 ? ((cur - base) / base) * 100 : 0;
  return { name:'10Y名义收益率', rawValue:Math.round(dev*100)/100, normalizedScore:clamp(50-dev*8,10,90), weight:w('us10y'), contribution:0 };
}

/**
 * TIPS 实际收益率 — 黄金最重要的单一驱动因子
 * 实际收益率 = 名义利率 - 通胀预期，TIPS 直接反映。
 * 实际利率↑ → 黄金持有机会成本↑ → 承压
 * 实际利率↓（甚至负值）→ 黄金吸引力↑ → 受益
 */
function tipsFactor(tips: number[]): QuantFactorDetail {
  const ma = latestMA(tips, 20);
  const cur = tips[tips.length - 1];
  const base = ma ?? cur;
  const dev = base !== 0 ? ((cur - base) / Math.abs(base)) * 100 : cur * 100;
  return { name:'实际收益率(TIPS)', rawValue:Math.round(cur*10000)/10000, normalizedScore:clamp(50-dev*0.8,10,90), weight:w('tips'), contribution:0 };
}

// ============================================================
// 因子 10：波动率 (ATR/Price)
// 高波动 → 不确定性，对黄金为中性偏多信号（避险需求）
// ============================================================
function volatilityFactor(closes: number[]): QuantFactorDetail {
  const period = 14;
  if (closes.length < period + 1) {
    return { name:'波动率(ATR)', rawValue:0, normalizedScore:50, weight:w('volatility'), contribution:0 };
  }
  let sumTR = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    sumTR += Math.abs(closes[i] - closes[i - 1]) / closes[i - 1] * 100;
  }
  const atrPct = sumTR / period;
  const normalized = clamp(50 + (0.5 - atrPct) * 20, 30, 70);
  return { name:'波动率(ATR)', rawValue:Math.round(atrPct*100)/100, normalizedScore:Math.round(normalized), weight:w('volatility'), contribution:0 };
}

// ============================================================
// 因子 11：宏观阶段
// ============================================================
function regimeFactor(regimeTag?: string): QuantFactorDetail {
  const map: Record<string, number> = {
    'recession_risk':85, 'dovish_pivot':80, 'stagflation':78,
    'soft_landing':55, 'goldilocks':45, 'hawkish':30, 'tightening':25,
    'strong_dollar':35, 'risk_on':40, 'disinflation_boom':40,
  };
  return { name:'宏观阶段', rawValue:0, normalizedScore:map[regimeTag??'']??50, weight:w('regime'), contribution:0 };
}

// ============================================================
// 因子 12：事件热度（Tavily 关键词计数，零 LLM）
// 关键词出现频率 → 判断市场关注度与方向。
// 默认关闭（权重 0），启用时需要 Tavily 搜索并传 eventScore。
// ============================================================
function eventHeatFactor(eventScore?: number): QuantFactorDetail {
  const raw = eventScore ?? 50;
  return { name:'事件热度', rawValue:raw, normalizedScore:clamp(raw,10,90), weight:w('event_heat'), contribution:0 };
}

// ============================================================
// 主函数
// ============================================================

export function computeQuantScore(params: QuantScoreParams): QuantScoreResult {
  const { closes, dxy, us10y, tips, flowSignal, regimeTag, eventScore } = params;

  if (closes.length < 20) {
    return minimalResult(flowSignal?.overallScore ?? 50, regimeTag);
  }

  const factors: QuantScoreResult['factors'] = {};

  factors.trend      = trendFactor(closes);
  factors.rsi        = rsiFactor(closes);
  factors.macd       = macdFactor(closes);
  factors.bollinger  = bollingerFactor(closes);
  factors.valuation  = valuationFactor(closes);
  factors.flow       = flowFactor(flowSignal);
  factors.volatility = volatilityFactor(closes);

  if (dxy && dxy.length >= 20)    factors.dxy   = dxyFactor(dxy);
  if (us10y && us10y.length >= 20) factors.us10y = us10yFactor(us10y);
  if (tips && tips.length >= 20)   factors.tips  = tipsFactor(tips);
  if (regimeTag && w('regime') > 0) factors.regime = regimeFactor(regimeTag);
  if (eventScore != null && w('event_heat') > 0) factors.event_heat = eventHeatFactor(eventScore);

  let totalScore = 0;
  for (const f of Object.values(factors) as QuantFactorDetail[]) {
    f.contribution = Math.round(f.normalizedScore * f.weight * 100) / 100;
    totalScore += f.contribution;
  }

  const finalScore = Math.round(clamp(totalScore, 0, 100));
  return { score:finalScore, direction:finalScore>=58?'bullish':finalScore<=42?'bearish':'neutral', factors };
}

function minimalResult(defaultFlow: number, regimeTag?: string): QuantScoreResult {
  const f: QuantScoreResult['factors'] = {};
  f.trend = { name:'趋势', rawValue:0, normalizedScore:50, weight:w('trend'), contribution:50*w('trend') };
  f.rsi   = { name:'RSI', rawValue:50, normalizedScore:50, weight:w('rsi'), contribution:50*w('rsi') };
  f.macd  = { name:'MACD', rawValue:0, normalizedScore:50, weight:w('macd'), contribution:50*w('macd') };
  f.flow  = { name:'主力', rawValue:defaultFlow, normalizedScore:defaultFlow, weight:w('flow'), contribution:defaultFlow*w('flow') };
  if (regimeTag && w('regime') > 0) {
    const r = regimeFactor(regimeTag);
    f.regime = { ...r, contribution: r.normalizedScore * w('regime') };
  }
  let total = 0;
  for (const v of Object.values(f) as QuantFactorDetail[]) total += v.contribution;
  return { score:Math.round(clamp(total,0,100)), direction:'neutral', factors:f };
}

// ============================================================
// 格式化
// ============================================================

export function formatQuantScoreConsole(result: QuantScoreResult, indent = '  '): string {
  const lines: string[] = [];
  const bar = '─'.repeat(52);
  lines.push(`${indent}🔢 量化评分构成（纯本地计算，零 LLM）`);
  lines.push(`${indent}${bar}`);
  for (const f of Object.values(result.factors) as QuantFactorDetail[]) {
    const pct = Math.round(f.weight * 100);
    if (pct === 0) continue;
    lines.push(`${indent}  ${f.name.padEnd(16,' ')} 信号=${String(f.normalizedScore).padStart(3)} × ${String(pct).padStart(2)}%  →  +${f.contribution.toFixed(1)}`);
  }
  lines.push(`${indent}${bar}`);
  const dm: Record<string,string> = { bullish:'📈 偏多', bearish:'📉 偏空', neutral:'➡️ 中性' };
  lines.push(`${indent}  量化综合分`.padEnd(indent.length+14) + `= ${result.score}  ${dm[result.direction]}`);
  return lines.join('\n');
}

export function formatQuantScoreOneLine(result: QuantScoreResult): string {
  const keys = ['trend','rsi','macd','flow','dxy','tips','regime']
    .filter(k => result.factors[k])
    .map(k => `${k}=${result.factors[k].normalizedScore}`);
  return `[量化] ${keys.join('/')} → ${result.score}`;
}
