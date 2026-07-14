// 综合评分构成 — 展示「哪里加几分、哪里减几分」

import type { RebuttalAnalysis, RebuttalStrength, TechnicalAnalysis, FundamentalAnalysis, SentimentAnalysis, CalibrationContext } from '../types/analysis.js';
import { computeRebuttalAdjustment } from './rebuttal-score.js';

const DIM_WEIGHT = 1 / 3;

export interface DimensionContribution {
  name: '技术面' | '基本面' | '情绪面';
  score: number;
  weight: number;
  contribution: number;
}

export interface ScoreBreakdown {
  dimensions: DimensionContribution[];
  initialScore: number;
  rebuttal: {
    bearScore: number;
    bearishImpliedScore: number;
    strength: RebuttalStrength;
    multiplier: number;
    rawAdjustment: number;
    roundedDelta: number;
  };
  calibration?: {
    rawScore: number;
    offset: number;
    calibratedScore: number;
    reason: string;
  };
  finalScore: number;
  quantScore?: number;
}

const STRENGTH_LABEL: Record<RebuttalStrength, string> = {
  weak: '弱',
  moderate: '中等',
  strong: '强',
};

/** 从四维度 + 反驳结果构建完整评分链路 */
export function buildScoreBreakdown(
  technical: Pick<TechnicalAnalysis, 'score'>,
  fundamental: Pick<FundamentalAnalysis, 'score'>,
  sentiment: Pick<SentimentAnalysis, 'score'>,
  rebuttal: Pick<RebuttalAnalysis, 'bearScore' | 'rebuttalStrength' | 'adjustedScore'>,
): ScoreBreakdown {
  const dimensions: DimensionContribution[] = [
    { name: '技术面', score: technical.score, weight: DIM_WEIGHT, contribution: technical.score * DIM_WEIGHT },
    { name: '基本面', score: fundamental.score, weight: DIM_WEIGHT, contribution: fundamental.score * DIM_WEIGHT },
    { name: '情绪面', score: sentiment.score, weight: DIM_WEIGHT, contribution: sentiment.score * DIM_WEIGHT },
  ];

  const initialScore = Math.round(
    (technical.score + fundamental.score + sentiment.score) / 3,
  );

  const adj = computeRebuttalAdjustment(initialScore, rebuttal.bearScore, rebuttal.rebuttalStrength);
  const finalScore = rebuttal.adjustedScore ?? adj.adjustedScore;

  return {
    dimensions,
    initialScore,
    rebuttal: {
      bearScore: rebuttal.bearScore,
      bearishImpliedScore: adj.bearishImpliedScore,
      strength: rebuttal.rebuttalStrength,
      multiplier: adj.multiplier,
      rawAdjustment: adj.rawAdjustment,
      roundedDelta: finalScore - initialScore,
    },
    finalScore,
  };
}

/** 将编排后的校准偏移并入评分链路（展示用） */
export function extendBreakdownWithCalibration(
  bd: ScoreBreakdown,
  cal: Pick<CalibrationContext, 'rawScore' | 'calibrationOffset' | 'calibrationApplied' | 'calibrationReason'> | undefined,
  displayScore: number,
): ScoreBreakdown {
  if (!cal?.calibrationApplied || cal.calibrationOffset == null || cal.calibrationOffset === 0) {
    return { ...bd, finalScore: displayScore, quantScore: bd.quantScore };
  }
  const rawScore = cal.rawScore ?? bd.finalScore;
  return {
    ...bd,
    calibration: {
      rawScore,
      offset: cal.calibrationOffset,
      calibratedScore: displayScore,
      reason: cal.calibrationReason ?? '历史校准修正',
    },
    finalScore: displayScore,
    quantScore: bd.quantScore,
  };
}

function fmtDelta(n: number, decimals = 1): string {
  const rounded = Math.round(n * 10 ** decimals) / 10 ** decimals;
  if (rounded > 0) return `+${rounded}`;
  if (rounded === 0) return '±0';
  return String(rounded);
}

/** 格式化 LLM 与量化评分的对比字符串 */
export function formatQuantScoreDiff(llmScore: number, quantScore: number): string {
  const diff = llmScore - quantScore;
  const absDiff = Math.abs(diff);
  if (diff > 0) {
    return `LLM=${llmScore} vs 量化=${quantScore} (LLM偏高 +${absDiff})`;
  } else if (diff < 0) {
    return `LLM=${llmScore} vs 量化=${quantScore} (LLM偏低 -${absDiff})`;
  }
  return `LLM=${llmScore} vs 量化=${quantScore} (一致)`;
}

/** CLI 终端输出（带缩进） */
export function formatScoreBreakdownConsole(bd: ScoreBreakdown, indent = '  '): string {
  const lines: string[] = [];
  const bar = '─'.repeat(42);

  lines.push(`${indent}📊 评分构成`);
  lines.push(`${indent}${bar}`);

  for (const d of bd.dimensions) {
    const pct = Math.round(d.weight * 100);
    lines.push(
      `${indent}  ${d.name.padEnd(5, '　')} ${String(d.score).padStart(3)} × ${pct}%`.replace('  ', ' ')
        + `  →  ${fmtDelta(d.contribution)} 分`,
    );
  }

  lines.push(`${indent}${bar}`);
  lines.push(`${indent}  三维度均分（初步）`.padEnd(indent.length + 22) + `= ${bd.initialScore}`);

  const r = bd.rebuttal;
  const multPct = Math.round(r.multiplier * 100);
  lines.push(`${indent}  强制反驳  ${STRENGTH_LABEL[r.strength]} × ${multPct}%`);
  lines.push(`${indent}    看空力度 bearScore = ${r.bearScore}  →  隐含偏多 ${r.bearishImpliedScore}`);
  lines.push(
    `${indent}    修正量  (${r.bearishImpliedScore} − ${bd.initialScore}) × ${r.multiplier}`
      + `  →  ${fmtDelta(r.rawAdjustment)}  →  取整 ${fmtDelta(r.roundedDelta)}`,
  );

  if (bd.calibration) {
    const c = bd.calibration;
    const offStr = c.offset > 0 ? `+${c.offset}` : String(c.offset);
    lines.push(`${indent}  历史校准  ${c.reason}`);
    lines.push(`${indent}    反驳后 ${c.rawScore}  →  偏移 ${offStr}  →  **${c.calibratedScore}**`);
  }

  lines.push(`${indent}${bar}`);
  lines.push(`${indent}  最终综合分`.padEnd(indent.length + 14) + `= ${bd.finalScore}`);

  if (bd.quantScore !== undefined) {
    const diff = bd.finalScore - bd.quantScore;
    const absDiff = Math.abs(diff);
    const diffStr = diff > 0 ? `LLM偏高 +${absDiff}` : diff < 0 ? `LLM偏低 -${absDiff}` : '一致';
    const qBar = '█'.repeat(Math.round(bd.quantScore / 100 * 20)) + '░'.repeat(20 - Math.round(bd.quantScore / 100 * 20));
    lines.push(`${indent}  量化评分  ${qBar} ${bd.quantScore}/100`);
    lines.push(`${indent}  LLM偏差    ${diffStr}`);
  }

  lines.push(`${indent}  （基金面估值不参与均分，仅作策略参考）`);

  return lines.join('\n');
}

/** Markdown 日报段落（供 report-md 与 server 解析） */
export function formatScoreBreakdownMarkdown(bd: ScoreBreakdown): string[] {
  const lines: string[] = [];
  lines.push('## 📊 评分构成');
  lines.push('');
  lines.push('| 步骤 | 明细 | 变动 | 累计 |');
  lines.push('|------|------|------|------|');

  for (const d of bd.dimensions) {
    const pct = Math.round(d.weight * 100);
    lines.push(`| ${d.name} | ${d.score}/100 × ${pct}% | ${fmtDelta(d.contribution)} | — |`);
  }

  const sumExpr = bd.dimensions.map(d => d.score).join('+');
  lines.push(`| 三维度均分 | (${sumExpr}) ÷ 3 | — | **${bd.initialScore}** |`);

  const r = bd.rebuttal;
  const multPct = Math.round(r.multiplier * 100);
  lines.push(
    `| 反驳修正 | bear=${r.bearScore}，${STRENGTH_LABEL[r.strength]}×${multPct}% | **${fmtDelta(r.roundedDelta)}** | **${bd.calibration ? bd.calibration.rawScore : bd.finalScore}** |`,
  );
  if (bd.calibration) {
    const offStr = bd.calibration.offset > 0 ? `+${bd.calibration.offset}` : String(bd.calibration.offset);
    lines.push(
      `| 历史校准 | ${bd.calibration.reason} | **${offStr}** | **${bd.calibration.calibratedScore}** |`,
    );
  }
  lines.push(`| **最终综合分** | ${bd.calibration ? '校准后展示分' : `看空隐含 ${r.bearishImpliedScore}，公式 (${r.bearishImpliedScore}−${bd.initialScore})×${r.multiplier}`} | | **${bd.finalScore}** |`);
  if (bd.quantScore !== undefined) {
    const diff = bd.finalScore - bd.quantScore;
    const absDiff = Math.abs(diff);
    const diffLabel = diff > 0 ? 'LLM偏高' : diff < 0 ? 'LLM偏低' : '一致';
    const diffStr = diff > 0 ? `+${absDiff}` : diff < 0 ? `-${absDiff}` : '0';
    lines.push(`| 量化对比 | 量化=${bd.quantScore} | **${diffStr}** | ${diffLabel} |`);
  }
  lines.push('');
  lines.push('> 基金面估值不参与均分，仅作策略参考。');
  lines.push('');

  return lines;
}

/** 单行摘要，适合流水线日志 */
export function formatScoreBreakdownOneLine(bd: ScoreBreakdown): string {
  const dims = bd.dimensions.map(d => `${d.name.slice(0, 2)}${d.score}`).join('/');
  const delta = bd.rebuttal.roundedDelta;
  const deltaStr = delta > 0 ? `+${delta}` : String(delta);
  return `${dims} → 均${bd.initialScore} → 反驳${deltaStr} → **${bd.finalScore}**`;
}
