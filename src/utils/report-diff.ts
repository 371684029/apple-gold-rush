// 报告对比 — 两日评分与情景变化

import type { GoldAnalysisReport } from '../types/analysis.js';
import type { ScoreBreakdown } from './score-breakdown.js';
import { buildScoreBreakdown } from './score-breakdown.js';

export interface ReportDiffLine {
  field: string;
  before: string;
  after: string;
  delta: string;
}

export interface ReportDiff {
  dateA: string;
  dateB: string;
  headline: string;
  lines: ReportDiffLine[];
}

function fmtDelta(n: number): string {
  if (n > 0) return `+${n}`;
  if (n === 0) return '±0';
  return String(n);
}

function dirLabel(d: string | undefined): string {
  if (d === 'bullish') return '偏多';
  if (d === 'bearish') return '偏空';
  return '中性';
}

export function diffReports(
  dateA: string,
  dateB: string,
  reportA: GoldAnalysisReport,
  reportB: GoldAnalysisReport,
): ReportDiff {
  const bdA = buildScoreBreakdown(reportA.technical, reportA.fundamental, reportA.sentiment, reportA.rebuttal);
  const bdB = buildScoreBreakdown(reportB.technical, reportB.fundamental, reportB.sentiment, reportB.rebuttal);

  const lines: ReportDiffLine[] = [];

  const scoreDelta = bdB.finalScore - bdA.finalScore;
  lines.push({
    field: '综合分',
    before: String(bdA.finalScore),
    after: String(bdB.finalScore),
    delta: fmtDelta(scoreDelta),
  });

  lines.push({
    field: '方向',
    before: dirLabel(reportA.overall?.direction),
    after: dirLabel(reportB.overall?.direction),
    delta: reportA.overall?.direction === reportB.overall?.direction ? '—' : '变化',
  });

  for (const name of ['技术面', '基本面', '情绪面'] as const) {
    const key = name === '技术面' ? 'technical' : name === '基本面' ? 'fundamental' : 'sentiment';
    const sa = reportA[key]?.score ?? 0;
    const sb = reportB[key]?.score ?? 0;
    lines.push({ field: name, before: String(sa), after: String(sb), delta: fmtDelta(sb - sa) });
  }

  lines.push({
    field: '三维度均分',
    before: String(bdA.initialScore),
    after: String(bdB.initialScore),
    delta: fmtDelta(bdB.initialScore - bdA.initialScore),
  });

  lines.push({
    field: '反驳修正',
    before: fmtDelta(bdA.rebuttal.roundedDelta),
    after: fmtDelta(bdB.rebuttal.roundedDelta),
    delta: fmtDelta(bdB.rebuttal.roundedDelta - bdA.rebuttal.roundedDelta),
  });

  const prob = (r: GoldAnalysisReport, k: 'base' | 'upside' | 'downside') =>
    r.overall?.scenarios?.[k]?.probability ?? null;

  for (const [label, k] of [['基准概率', 'base'], ['上行概率', 'upside'], ['下行概率', 'downside']] as const) {
    const pa = prob(reportA, k);
    const pb = prob(reportB, k);
    if (pa != null && pb != null) {
      lines.push({
        field: label,
        before: `${pa}%`,
        after: `${pb}%`,
        delta: fmtDelta(pb - pa),
      });
    }
  }

  let headline: string;
  if (Math.abs(scoreDelta) >= 8) {
    headline = `综合分大幅${scoreDelta > 0 ? '上升' : '下降'} ${Math.abs(scoreDelta)} 分，需重新评估定投节奏`;
  } else if (Math.abs(scoreDelta) >= 3) {
    headline = `综合分${scoreDelta > 0 ? '上调' : '下调'} ${Math.abs(scoreDelta)} 分，${findMaxDimChange(lines)}`;
  } else {
    headline = `综合分基本持平（${fmtDelta(scoreDelta)}），市场研判未显著变化`;
  }

  return { dateA, dateB, headline, lines };
}

function findMaxDimChange(lines: ReportDiffLine[]): string {
  const dims = lines.filter(l => ['技术面', '基本面', '情绪面'].includes(l.field));
  if (dims.length === 0) return '关注情景概率变化';
  const max = dims.reduce((a, b) =>
    Math.abs(parseInt(b.delta, 10) || 0) > Math.abs(parseInt(a.delta, 10) || 0) ? b : a,
  );
  return `主要变化在${max.field}（${max.delta}）`;
}

export function formatReportDiffConsole(diff: ReportDiff): string {
  const rows = diff.lines.map(l =>
    `  ${l.field.padEnd(10, '　')}  ${l.before.padStart(6)} → ${l.after.padStart(6)}  (${l.delta})`,
  );
  return [
    `\n📋 报告对比：${diff.dateA} vs ${diff.dateB}`,
    `  💡 ${diff.headline}`,
    '',
    ...rows,
  ].join('\n');
}
