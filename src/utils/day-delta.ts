// 较昨日差分 + 驱动归因 — 解决「每天日报都差不多」的阅读价值问题
//
// 原则：
// 1. 定投用户优先看「今天相对昨天要不要动」
// 2. 无显著变化时明确写「可跳过细读」，不要硬编新故事
// 3. 驱动归因只报有数字的变化（金价/利率/美元/flow），不编造

import type { GoldAnalysisReport } from '../types/analysis.js';
import type { GoldPriceRecord } from '../types/market.js';
import type { DualScoreVerdict } from './dual-score.js';
import { extractPreviousTargetPct } from './position-recommend.js';

export interface DriverMove {
  key: string;
  label: string;
  before: number | null;
  after: number | null;
  delta: number | null;
  unit: string;
  /** 对黄金的直觉方向：supportive / headwind / neutral */
  goldBias: 'supportive' | 'headwind' | 'neutral';
}

export interface DayDelta {
  prevDate: string;
  currDate: string;
  /** 是否整体变化很小，可跳过细读 */
  skipFineRead: boolean;
  headline: string;
  scoreDelta: number | null;
  quantDelta: number | null;
  positionDelta: number | null;
  prevScore: number | null;
  currScore: number | null;
  prevQuant: number | null;
  currQuant: number | null;
  prevPositionPct: number | null;
  currPositionPct: number | null;
  scenarioDeltas: Array<{ key: string; label: string; before: number; after: number; delta: number }>;
  drivers: DriverMove[];
  /** 一句驱动摘要 */
  driverSummary: string;
  /** 校准叙事提示（谁近期更准，不改仓位权重） */
  trackHint: string | null;
}

function fmtDelta(n: number, digits = 0): string {
  const v = digits > 0 ? Number(n.toFixed(digits)) : Math.round(n);
  if (v > 0) return `+${v}`;
  if (v === 0) return '±0';
  return String(v);
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function scenarioProb(r: GoldAnalysisReport | null | undefined, k: 'base' | 'upside' | 'downside'): number | null {
  return numOrNull(r?.overall?.scenarios?.[k]?.probability);
}

/**
 * 从金价/flow 两日快照提取驱动变化
 */
export function buildDriverMoves(
  prevPrice: GoldPriceRecord | null | undefined,
  currPrice: GoldPriceRecord | null | undefined,
  prevFlowScore: number | null | undefined,
  currFlowScore: number | null | undefined,
): DriverMove[] {
  const moves: DriverMove[] = [];

  const push = (
    key: string,
    label: string,
    before: number | null | undefined,
    after: number | null | undefined,
    unit: string,
    biasFn: (d: number) => DriverMove['goldBias'],
    digits = 2,
  ) => {
    if (before == null || after == null || !Number.isFinite(before) || !Number.isFinite(after)) return;
    const delta = Number((after - before).toFixed(digits));
    if (Math.abs(delta) < (digits >= 2 ? 0.01 : 0.5)) return;
    moves.push({
      key, label,
      before: Number(before.toFixed(digits)),
      after: Number(after.toFixed(digits)),
      delta,
      unit,
      goldBias: biasFn(delta),
    });
  };

  push('london', '伦敦金', prevPrice?.londonClose, currPrice?.londonClose, '$', () => 'neutral', 1);
  // 实际利率升 → 黄金承压
  push('tips', '实际利率(TIPS)', prevPrice?.tipsYield, currPrice?.tipsYield, '%', d => (d > 0 ? 'headwind' : 'supportive'), 2);
  push('us10y', '美债10Y', prevPrice?.us10yYield, currPrice?.us10yYield, '%', d => (d > 0 ? 'headwind' : 'supportive'), 2);
  push('dxy', '美元指数', prevPrice?.dollarIndex, currPrice?.dollarIndex, '', d => (d > 0 ? 'headwind' : 'supportive'), 2);
  push('flow', '主力综合分', prevFlowScore, currFlowScore, '', d => (d > 0 ? 'supportive' : 'headwind'), 0);

  // 按 |Δ| 排序，重要变化在前
  moves.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  return moves;
}

function summarizeDrivers(drivers: DriverMove[]): string {
  if (!drivers.length) return '宏观驱动较昨日无明显数字变化';
  const top = drivers.slice(0, 3).map(d => {
    const sign = d.goldBias === 'supportive' ? '利多' : d.goldBias === 'headwind' ? '利空' : '中性';
    return `${d.label}${fmtDelta(d.delta!, d.unit === '%' || d.unit === '' ? 2 : 1)}${d.unit}（${sign}）`;
  });
  return top.join('；');
}

export interface BuildDayDeltaInput {
  prevDate: string;
  currDate: string;
  previous: GoldAnalysisReport | null;
  current: GoldAnalysisReport;
  currPositionPct: number | null;
  dual?: Pick<DualScoreVerdict, 'delta' | 'actionPolicy'> | null;
  prevPrice?: GoldPriceRecord | null;
  currPrice?: GoldPriceRecord | null;
  prevFlowScore?: number | null;
  currFlowScore?: number | null;
  /** LLM/量化近期命中率 0–100，用于叙事提示 */
  llmHitRate?: number | null;
  quantHitRate?: number | null;
}

/**
 * 构建较昨日一览
 */
export function buildDayDelta(input: BuildDayDeltaInput): DayDelta {
  const prev = input.previous;
  const curr = input.current;

  const prevScore = numOrNull(prev?.overall?.score);
  const currScore = numOrNull(curr.overall?.score);
  const prevQuant = numOrNull(prev?.overall?.quantScore);
  const currQuant = numOrNull(curr.overall?.quantScore);
  const prevPos = prev ? extractPreviousTargetPct(prev) : null;
  const currPos = input.currPositionPct;

  const scoreDelta = prevScore != null && currScore != null ? currScore - prevScore : null;
  const quantDelta = prevQuant != null && currQuant != null ? currQuant - prevQuant : null;
  const positionDelta = prevPos != null && currPos != null ? currPos - prevPos : null;

  const scenarioDeltas: DayDelta['scenarioDeltas'] = [];
  for (const [key, label] of [['base', '基准'], ['upside', '上行'], ['downside', '下行']] as const) {
    const a = scenarioProb(prev, key);
    const b = scenarioProb(curr, key);
    if (a != null && b != null) {
      scenarioDeltas.push({ key, label, before: a, after: b, delta: b - a });
    }
  }

  const drivers = buildDriverMoves(
    input.prevPrice,
    input.currPrice,
    input.prevFlowScore,
    input.currFlowScore,
  );
  const driverSummary = summarizeDrivers(drivers);

  // 显著变化阈值：分数≥3 或 仓位≥5 或 情景≥8 或 有驱动
  const scoreMoved = scoreDelta != null && Math.abs(scoreDelta) >= 3;
  const posMoved = positionDelta != null && Math.abs(positionDelta) >= 5;
  const scenMoved = scenarioDeltas.some(s => Math.abs(s.delta) >= 8);
  const driverMoved = drivers.length > 0;
  const skipFineRead = !scoreMoved && !posMoved && !scenMoved && !driverMoved;

  let headline: string;
  if (!prev) {
    headline = '无昨日报告可对比（首日或断档）';
  } else if (skipFineRead) {
    headline = `与昨日（${input.prevDate}）基本持平，可跳过细读`;
  } else {
    const bits: string[] = [];
    if (scoreDelta != null) bits.push(`综合分${fmtDelta(scoreDelta)}`);
    if (positionDelta != null) bits.push(`仓位${fmtDelta(positionDelta)}点`);
    if (scenMoved) {
      const max = scenarioDeltas.reduce((a, b) => Math.abs(b.delta) > Math.abs(a.delta) ? b : a);
      bits.push(`${max.label}概率${fmtDelta(max.delta)}%`);
    }
    headline = `较昨日有变化：${bits.join(' · ')}`;
  }

  let trackHint: string | null = null;
  // 兼容 0–1 或 0–100
  const toPct = (v: number) => (v <= 1 ? v * 100 : v);
  const lr = input.llmHitRate != null && Number.isFinite(input.llmHitRate) ? toPct(input.llmHitRate) : null;
  const qr = input.quantHitRate != null && Number.isFinite(input.quantHitRate) ? toPct(input.quantHitRate) : null;
  if (lr != null && qr != null) {
    if (Math.abs(lr - qr) >= 8) {
      const better = lr > qr ? 'LLM' : '量化';
      trackHint = `近窗方向命中：LLM ${Math.round(lr)}% / 量化 ${Math.round(qr)}% → 叙事可略偏${better}，仓位仍不抬单侧权重`;
    } else {
      trackHint = `近窗方向命中接近：LLM ${Math.round(lr)}% / 量化 ${Math.round(qr)}%`;
    }
  }

  return {
    prevDate: input.prevDate,
    currDate: input.currDate,
    skipFineRead,
    headline,
    scoreDelta,
    quantDelta,
    positionDelta,
    prevScore,
    currScore,
    prevQuant,
    currQuant,
    prevPositionPct: prevPos,
    currPositionPct: currPos,
    scenarioDeltas,
    drivers,
    driverSummary,
    trackHint,
  };
}

export function formatDayDeltaConsole(d: DayDelta, indent = '  '): string {
  const lines = [
    `${indent}📅 较昨日（${d.prevDate || '—'} → ${d.currDate}）`,
    `${indent}  ${d.headline}`,
  ];
  if (d.scoreDelta != null) {
    lines.push(`${indent}  综合分 ${d.prevScore} → ${d.currScore}（${fmtDelta(d.scoreDelta)}）`);
  }
  if (d.quantDelta != null) {
    lines.push(`${indent}  量化分 ${d.prevQuant} → ${d.currQuant}（${fmtDelta(d.quantDelta)}）`);
  }
  if (d.positionDelta != null) {
    lines.push(`${indent}  建议仓位 ${d.prevPositionPct}% → ${d.currPositionPct}%（${fmtDelta(d.positionDelta)}点）`);
  }
  lines.push(`${indent}  驱动：${d.driverSummary}`);
  if (d.trackHint) lines.push(`${indent}  ${d.trackHint}`);
  return lines.join('\n');
}

export function formatDayDeltaMarkdown(d: DayDelta): string {
  const lines = [
    '## 📅 较昨日一览',
    '',
    `> **${d.headline}**`,
    '',
  ];
  if (d.skipFineRead && d.prevDate) {
    lines.push('- 💡 与昨日差异很小：可只看仓位%与可信度，细文可跳过');
    lines.push('');
  }
  lines.push('| 项 | 昨日 | 今日 | Δ |');
  lines.push('|----|------|------|---|');
  if (d.prevScore != null && d.currScore != null) {
    lines.push(`| 综合分 | ${d.prevScore} | ${d.currScore} | ${fmtDelta(d.scoreDelta!)} |`);
  }
  if (d.prevQuant != null && d.currQuant != null) {
    lines.push(`| 量化分 | ${d.prevQuant} | ${d.currQuant} | ${fmtDelta(d.quantDelta!)} |`);
  }
  if (d.prevPositionPct != null && d.currPositionPct != null) {
    lines.push(`| 建议仓位 | ${d.prevPositionPct}% | ${d.currPositionPct}% | ${fmtDelta(d.positionDelta!)}点 |`);
  }
  for (const s of d.scenarioDeltas) {
    lines.push(`| ${s.label}概率 | ${s.before}% | ${s.after}% | ${fmtDelta(s.delta)}% |`);
  }
  lines.push('');
  lines.push(`- **驱动归因**：${d.driverSummary}`);
  if (d.drivers.length) {
    for (const dr of d.drivers.slice(0, 5)) {
      const bias = dr.goldBias === 'supportive' ? '利多金' : dr.goldBias === 'headwind' ? '利空金' : '中性';
      lines.push(`  - ${dr.label}：${dr.before}${dr.unit} → ${dr.after}${dr.unit}（${fmtDelta(dr.delta!, 2)}，${bias}）`);
    }
  }
  if (d.trackHint) {
    lines.push(`- **校准叙事**：${d.trackHint}`);
  }
  lines.push('');
  return lines.join('\n');
}
