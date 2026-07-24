// 可信度一览卡 — 把门禁/双分/一致性/校准压成「能不能信」一页
// 目标：准确率不吹嘘、可靠性可量化、日常一眼读完

import type { Direction } from '../types/analysis.js';
import type { DataQualityGate } from './data-quality-gate.js';
import type { DualScoreVerdict } from './dual-score.js';
import type { ConsistencyCheck } from './plain-advice.js';
import type { PositionRecommendation } from './position-recommend.js';
import type { DayDelta } from './day-delta.js';

export type ReliabilityTier = 'high' | 'medium' | 'low' | 'blocked';

export interface ReliabilityCard {
  /** 0–100，越高越「可据以做纪律操作」；≠ 金价预测准确率 */
  score: number;
  tier: ReliabilityTier;
  emoji: string;
  label: string;
  /** 评分展示区间（替代单点绝对感） */
  scoreBand: { low: number; high: number; center: number };
  /** 区间半宽（由不确定性推） */
  bandHalfWidth: number;
  factors: Array<{ name: string; ok: boolean; detail: string; weight: number; points: number }>;
  warnings: string[];
  /** 三行 TL;DR */
  tldr: {
    line1: string; // 较昨日 + 研判区间
    line2: string; // 仓位 + 驱动
    line3: string; // 可信度+注意
  };
  summary: string;
}

export interface ReliabilityCardInput {
  llmScore: number;
  direction?: Direction | null;
  quantScore?: number | null;
  dataGate?: Pick<DataQualityGate, 'tier' | 'actionable' | 'overallConfidence' | 'banners'> | null;
  dual?: Pick<DualScoreVerdict, 'alignment' | 'delta' | 'actionPolicy' | 'sameDirection'> | null;
  consistency?: Pick<ConsistencyCheck, 'level' | 'summary' | 'agreeCount' | 'totalCount'> | null;
  calibrationSampleSize?: number | null;
  calibrationBias?: string | null;
  position?: Pick<PositionRecommendation, 'targetPct' | 'label' | 'emoji' | 'headline' | 'tilt'> | null;
  /** 历史 5 日 LLM 方向命中率 0–1（可选，有则进因子） */
  trackHitRate?: number | null;
  trackSampleSize?: number | null;
  /** 较昨日差分（抬高日报信息有效性） */
  dayDelta?: Pick<DayDelta, 'skipFineRead' | 'headline' | 'scoreDelta' | 'positionDelta' | 'driverSummary' | 'trackHint'> | null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function dirLabel(d?: Direction | null): string {
  if (d === 'bullish') return '偏多';
  if (d === 'bearish') return '偏空';
  if (d === 'neutral') return '中性';
  return '方向未明';
}

/**
 * 综合「操作可信度」（非预测准确率承诺）
 */
export function buildReliabilityCard(input: ReliabilityCardInput): ReliabilityCard {
  const factors: ReliabilityCard['factors'] = [];
  const warnings: string[] = [];
  let points = 0;
  let weightSum = 0;

  // 1) 数据门禁 35%
  {
    const w = 35;
    weightSum += w;
    const gate = input.dataGate;
    let p = 18;
    let ok = true;
    let detail = '无门禁数据';
    if (gate) {
      const conf = gate.overallConfidence;
      if (!gate.actionable || gate.tier === 'red') {
        p = 5;
        ok = false;
        detail = `红档 · 置信 ${conf}% · 勿据以加减仓`;
        warnings.push('数据门禁红档：操作结论已关闭');
      } else if (gate.tier === 'yellow') {
        p = 20;
        ok = false;
        detail = `黄档 · 置信 ${conf}% · 降级可用`;
        warnings.push('数据黄档：结论降级阅读');
      } else {
        p = conf >= 70 ? 35 : conf >= 55 ? 28 : 22;
        ok = true;
        detail = `绿档 · 置信 ${conf}%`;
      }
    }
    factors.push({ name: '数据质量', ok, detail, weight: w, points: p });
    points += p;
  }

  // 2) 双打分一致 25%
  {
    const w = 25;
    weightSum += w;
    const dual = input.dual;
    let p = 12;
    let ok = true;
    let detail = input.quantScore != null ? `量化 ${input.quantScore}（未评估对齐）` : '无量化分';
    if (dual) {
      const d = dual.delta;
      const dStr = d == null ? 'N/A' : `${d > 0 ? '+' : ''}${d}`;
      if (dual.alignment === 'conflict' || dual.actionPolicy === 'hold_on_conflict') {
        p = 6;
        ok = false;
        detail = `分歧 Δ${dStr} · 仓位受限`;
        warnings.push('LLM 与量化方向/幅度分歧');
      } else if (dual.alignment === 'mild_gap') {
        p = 16;
        ok = dual.sameDirection !== false;
        detail = `轻度偏差 Δ${dStr}${dual.sameDirection === false ? ' · 方向不一' : ''}`;
      } else {
        p = 25;
        ok = true;
        detail = `对齐良好 Δ${dStr}`;
      }
    } else if (input.quantScore == null) {
      p = 10;
      ok = false;
      detail = '缺量化分，仅 LLM';
      warnings.push('缺少可复现量化分');
    }
    factors.push({ name: '双打分', ok, detail, weight: w, points: p });
    points += p;
  }

  // 3) 四维一致性 20%
  {
    const w = 20;
    weightSum += w;
    const c = input.consistency;
    let p = 10;
    let ok = true;
    let detail = '未计算';
    if (c) {
      if (c.level === 'strong') {
        p = 20;
        ok = true;
      } else if (c.level === 'moderate') {
        p = 13;
        ok = true;
      } else {
        p = 6;
        ok = false;
        warnings.push('四维度方向分歧');
      }
      detail = c.summary;
    }
    factors.push({ name: '维度一致', ok, detail, weight: w, points: p });
    points += p;
  }

  // 4) 校准样本 15%
  {
    const w = 15;
    weightSum += w;
    const n = input.calibrationSampleSize ?? 0;
    let p = 4;
    let ok = false;
    let detail = `同分段样本 ${n}`;
    if (n >= 20) {
      p = 15;
      ok = true;
      detail = `样本充足 ${n}`;
    } else if (n >= 5) {
      p = 10;
      ok = true;
      detail = `样本可用 ${n}（仍偏少）`;
      warnings.push(`校准样本 ${n} < 20，命中率波动大`);
    } else if (n > 0) {
      p = 5;
      ok = false;
      detail = `样本不足 ${n}`;
      warnings.push(`校准样本仅 ${n}，分数仅供参考`);
    } else {
      p = 3;
      ok = false;
      detail = '无校准样本';
      warnings.push('尚无同分段校准样本');
    }
    if (input.calibrationBias && /乐观|悲观/.test(input.calibrationBias)) {
      detail += ` · ${input.calibrationBias}`;
    }
    factors.push({ name: '历史校准', ok, detail, weight: w, points: p });
    points += p;
  }

  // 5) 滚动命中（可选）5%
  {
    const w = 5;
    weightSum += w;
    // 兼容 0–1 比例或 0–100 百分数（prediction-track 输出为百分数）
    const hrRaw = input.trackHitRate;
    const hr = hrRaw == null ? null : (hrRaw > 1 ? hrRaw / 100 : hrRaw);
    const tn = input.trackSampleSize ?? 0;
    let p = 2;
    let ok = true;
    let detail = '暂无滚动命中';
    if (hr != null && tn >= 5) {
      if (hr >= 0.6) {
        p = 5;
        ok = true;
        detail = `近窗命中 ${(hr * 100).toFixed(0)}%（n=${tn}）`;
      } else if (hr >= 0.45) {
        p = 3;
        ok = true;
        detail = `近窗命中 ${(hr * 100).toFixed(0)}%（n=${tn}）· 接近随机`;
      } else {
        p = 1;
        ok = false;
        detail = `近窗命中仅 ${(hr * 100).toFixed(0)}%（n=${tn}）`;
        warnings.push('近窗方向命中偏低，宜降杠杆式操作');
      }
    }
    factors.push({ name: '滚动命中', ok, detail, weight: w, points: p });
    points += p;
  }

  // 归一到 0–100（权重合计 100）
  const score = Math.round(clamp((points / Math.max(weightSum, 1)) * 100, 0, 100));

  // 评分区间半宽：可信度越低区间越宽
  let half = 4;
  if (score < 40) half = 12;
  else if (score < 55) half = 9;
  else if (score < 70) half = 6;
  else half = 4;
  if (input.dataGate && !input.dataGate.actionable) half = Math.max(half, 12);
  if (input.dual?.actionPolicy === 'hold_on_conflict') half = Math.max(half, 8);

  const center = Math.round(input.llmScore);
  const scoreBand = {
    low: clamp(center - half, 0, 100),
    high: clamp(center + half, 0, 100),
    center,
  };

  let tier: ReliabilityTier = 'medium';
  if (input.dataGate && !input.dataGate.actionable) tier = 'blocked';
  else if (score >= 72) tier = 'high';
  else if (score >= 50) tier = 'medium';
  else tier = 'low';

  const emoji = tier === 'high' ? '🟢' : tier === 'medium' ? '🟡' : tier === 'blocked' ? '🔴' : '🟠';
  const label =
    tier === 'high' ? '可信度较高'
      : tier === 'medium' ? '可信度中等'
        : tier === 'blocked' ? '数据不可操作'
          : '可信度偏低';

  const pos = input.position;
  const dd = input.dayDelta;
  const posLine = pos
    ? `${pos.emoji} 建议仓位 ${pos.targetPct}%（${pos.label}）${
        dd?.positionDelta != null ? ` · 较昨日${dd.positionDelta > 0 ? '+' : ''}${dd.positionDelta}点` : ''
      }`
    : '仓位：见报告仓位节或按纪律定投';

  const driverBit = dd?.driverSummary
    ? dd.driverSummary.slice(0, 72)
    : '';

  let line1: string;
  if (dd?.skipFineRead) {
    line1 = `📅 与昨日持平，可跳过细读 · 研判 **${scoreBand.low}–${scoreBand.high}**/100 · ${dirLabel(input.direction)}`;
  } else if (dd && (dd.scoreDelta != null || dd.positionDelta != null)) {
    const bits: string[] = [];
    if (dd.scoreDelta != null) bits.push(`分${dd.scoreDelta > 0 ? '+' : ''}${dd.scoreDelta}`);
    if (dd.positionDelta != null) bits.push(`仓${dd.positionDelta > 0 ? '+' : ''}${dd.positionDelta}点`);
    line1 = `📅 较昨日 ${bits.join(' / ')} · 研判 **${scoreBand.low}–${scoreBand.high}**/100 · ${dirLabel(input.direction)}`;
  } else {
    line1 = `研判 **${scoreBand.low}–${scoreBand.high}**/100（中心 ${center}）· ${dirLabel(input.direction)}`;
  }

  const tldr = {
    line1,
    line2: driverBit ? `${posLine} · 驱动：${driverBit}` : posLine,
    line3: `${emoji} ${label} ${score}/100${
      dd?.trackHint ? ` · ${dd.trackHint}` : warnings[0] ? ` · 注意：${warnings[0]}` : ''
    }`,
  };

  const summary = `${emoji} ${label} ${score}/100 · 展示区间 ${scoreBand.low}–${scoreBand.high} · ${factors.filter(f => !f.ok).length} 项需关注`;

  return {
    score,
    tier,
    emoji,
    label,
    scoreBand,
    bandHalfWidth: half,
    factors,
    warnings,
    tldr,
    summary,
  };
}

export function formatReliabilityConsole(c: ReliabilityCard, indent = '  '): string {
  const lines = [
    `${indent}🛡️ 可信度一览（操作可信，非预测承诺）`,
    `${indent}  ${c.emoji} ${c.label} **${c.score}/100** · 评分区间 ${c.scoreBand.low}–${c.scoreBand.high}（中心 ${c.scoreBand.center}）`,
    `${indent}  ${c.tldr.line2.replace(/\*\*/g, '')}`,
  ];
  for (const f of c.factors) {
    lines.push(`${indent}  ${f.ok ? '✓' : '!'} ${f.name}: ${f.detail} (${f.points}/${f.weight})`);
  }
  if (c.warnings.length) {
    lines.push(`${indent}  ⚠️ ${c.warnings.slice(0, 3).join('；')}`);
  }
  return lines.join('\n');
}

export function formatReliabilityMarkdown(c: ReliabilityCard): string {
  const lines = [
    '## 🛡️ 可信度一览',
    '',
    `> ${c.emoji} **${c.label} ${c.score}/100** · 评分展示区间 **${c.scoreBand.low}–${c.scoreBand.high}**/100（中心 ${c.scoreBand.center}，半宽 ±${c.bandHalfWidth}）`,
    '',
    '### 三行看懂',
    '',
    `1. ${c.tldr.line1}`,
    `2. ${c.tldr.line2}`,
    `3. ${c.tldr.line3}`,
    '',
    '| 因子 | 得分 | 说明 |',
    '|------|------|------|',
  ];
  for (const f of c.factors) {
    lines.push(`| ${f.ok ? '✅' : '⚠️'} ${f.name} | ${f.points}/${f.weight} | ${f.detail} |`);
  }
  lines.push('');
  if (c.warnings.length) {
    lines.push(`- **注意**：${c.warnings.join('；')}`);
    lines.push('');
  }
  lines.push('> 可信度衡量「今日结论是否适合做纪律操作」，**不是**金价涨跌准确率保证。区间越宽表示不确定性越大。');
  lines.push('');
  return lines.join('\n');
}
