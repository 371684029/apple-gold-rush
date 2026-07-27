// Walk-forward 校准卫生 — 用前半段估规则，后半段样本外看偏差与命中
// 禁止「全样本调阈值后再报命中率」的自嗨

import type { CalibrationReport } from '../types/calibration.js';
import type { AnalysisReportRow } from '../db/reports.js';
import type { GoldPricesRepo } from '../db/gold-prices.js';
import { forwardReturnPct } from './forward-return.js';
import {
  predictDirectionFromScore,
  isHit,
  classifyReturn,
  formatHitRate,
  wilsonInterval,
  MIN_HITRATE_SAMPLE,
} from './decision-thresholds.js';

export interface WalkForwardSplit {
  trainFrom: string;
  trainTo: string;
  testFrom: string;
  testTo: string;
  trainBuckets: number;
  testBuckets: number;
  /** 训练集平均 |校准误差| */
  trainMae: number | null;
  /** 测试集平均 |校准误差| */
  testMae: number | null;
  /** 测试是否明显变差 */
  degraded: boolean;
  /** 样本外 LLM 方向命中（训练窗估规则无关，直接在测试窗记账） */
  oosLlmHits: number;
  oosLlmTotal: number;
  oosLlmHitRate: number | null;
  oosCiLow: number | null;
  oosCiHigh: number | null;
  /** 样本外永远看涨基准 */
  oosBaselineRate: number | null;
  summary: string;
}

function bucketMae(report: CalibrationReport): number | null {
  const usable = report.buckets.filter(b => b.sampleSize >= 3);
  if (!usable.length) return null;
  const sum = usable.reduce((s, b) => s + Math.abs(b.calibrationError), 0);
  return Math.round((sum / usable.length) * 10) / 10;
}

export interface OosHitInput {
  testReports: AnalysisReportRow[];
  prices: GoldPricesRepo;
  horizonDays?: number;
}

/** 在测试窗上独立记账方向命中（不依赖训练窗估出来的偏移） */
export function computeOosHitStats(input: OosHitInput): {
  hits: number;
  total: number;
  hitRate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  baselineRate: number | null;
} {
  const T = input.horizonDays ?? 5;
  let hits = 0;
  let total = 0;
  let baseUp = 0;
  let baseN = 0;
  for (const r of input.testReports) {
    const ret = forwardReturnPct(input.prices, r.date, T, { allowPartial: false });
    if (ret == null) continue;
    const cls = classifyReturn(ret);
    if (cls !== 'flat') {
      baseN++;
      if (cls === 'up') baseUp++;
    }
    const hit = isHit(predictDirectionFromScore(r.overallScore), ret);
    if (hit == null) continue;
    total++;
    if (hit) hits++;
  }
  const [lo, hi] = total > 0 ? wilsonInterval(hits, total) : [null, null];
  return {
    hits,
    total,
    hitRate: total > 0 ? Math.round((hits / total) * 1000) / 10 : null,
    ciLow: lo != null ? Math.round(lo * 1000) / 10 : null,
    ciHigh: hi != null ? Math.round(hi * 1000) / 10 : null,
    baselineRate: baseN > 0 ? Math.round((baseUp / baseN) * 1000) / 10 : null,
  };
}

/**
 * 对比训练窗与测试窗两份校准报告（由调用方按日期切分后分别 compute）
 * @param oos 可选：测试窗上的真实方向命中，补上「只比 MAE 不够」的空白
 */
export function summarizeWalkForward(
  train: CalibrationReport,
  test: CalibrationReport,
  oos?: ReturnType<typeof computeOosHitStats> | null,
): WalkForwardSplit {
  const trainMae = bucketMae(train);
  const testMae = bucketMae(test);
  const degraded =
    trainMae != null && testMae != null && testMae > trainMae + 8;

  const oosLlmHits = oos?.hits ?? 0;
  const oosLlmTotal = oos?.total ?? 0;
  const oosLlmHitRate = oos?.hitRate ?? null;
  const oosCiLow = oos?.ciLow ?? null;
  const oosCiHigh = oos?.ciHigh ?? null;
  const oosBaselineRate = oos?.baselineRate ?? null;

  let summary: string;
  if (trainMae == null || testMae == null) {
    summary = '样本不足，无法做可靠 walk-forward';
  } else if (degraded) {
    summary = `样本外误差变差（训练 MAE ${trainMae}% → 测试 ${testMae}%）：全样本命中率可能偏乐观`;
  } else {
    summary = `样本外尚可（训练 MAE ${trainMae}% → 测试 ${testMae}%）`;
  }

  if (oosLlmTotal > 0) {
    const hr = formatHitRate(oosLlmHits, oosLlmTotal, oosBaselineRate != null ? oosBaselineRate / 100 : 0.5);
    summary += `；测试窗 LLM 方向命中 ${hr}`;
    if (oosBaselineRate != null) {
      summary += `（永远看涨基准 ${oosBaselineRate}%）`;
    }
  } else if (oos) {
    summary += '；测试窗方向命中样本不足';
  }

  return {
    trainFrom: train.period.from,
    trainTo: train.period.to,
    testFrom: test.period.from,
    testTo: test.period.to,
    trainBuckets: train.buckets.length,
    testBuckets: test.buckets.length,
    trainMae,
    testMae,
    degraded,
    oosLlmHits,
    oosLlmTotal,
    oosLlmHitRate,
    oosCiLow,
    oosCiHigh,
    oosBaselineRate,
    summary,
  };
}

export function formatWalkForwardConsole(wf: WalkForwardSplit, indent = '  '): string {
  const lines = [
    `${indent}🚶 Walk-forward 卫生检查`,
    `${indent}  训练 ${wf.trainFrom}~${wf.trainTo}（${wf.trainBuckets} 桶）MAE ${wf.trainMae ?? 'N/A'}%`,
    `${indent}  测试 ${wf.testFrom}~${wf.testTo}（${wf.testBuckets} 桶）MAE ${wf.testMae ?? 'N/A'}%`,
  ];
  if (wf.oosLlmTotal > 0) {
    const ci = wf.oosCiLow != null && wf.oosCiHigh != null
      ? ` · 95%CI ${wf.oosCiLow}–${wf.oosCiHigh}%`
      : '';
    const note = wf.oosLlmTotal < MIN_HITRATE_SAMPLE ? ' · 样本不足，不具统计意义' : '';
    lines.push(
      `${indent}  测试窗命中 ${wf.oosLlmHits}/${wf.oosLlmTotal}`
      + (wf.oosLlmHitRate != null ? `（${wf.oosLlmHitRate}%${ci}）` : '')
      + note,
    );
  }
  lines.push(`${indent}  ${wf.degraded ? '⚠️' : '✅'} ${wf.summary}`);
  return lines.join('\n');
}

export function formatWalkForwardMarkdown(wf: WalkForwardSplit): string {
  const lines = [
    '## 🚶 Walk-forward 卫生',
    '',
    `| 窗 | 区间 | 分桶数 | MAE |`,
    `|----|------|--------|-----|`,
    `| 训练 | ${wf.trainFrom} ~ ${wf.trainTo} | ${wf.trainBuckets} | ${wf.trainMae ?? 'N/A'}% |`,
    `| 测试 | ${wf.testFrom} ~ ${wf.testTo} | ${wf.testBuckets} | ${wf.testMae ?? 'N/A'}% |`,
    '',
  ];
  if (wf.oosLlmTotal > 0) {
    lines.push(
      `测试窗 LLM 方向命中：**${wf.oosLlmHits}/${wf.oosLlmTotal}**`
      + (wf.oosLlmHitRate != null ? `（${wf.oosLlmHitRate}%` : '')
      + (wf.oosCiLow != null && wf.oosCiHigh != null ? ` · 95%CI ${wf.oosCiLow}–${wf.oosCiHigh}%` : '')
      + (wf.oosLlmHitRate != null ? '）' : '')
      + (wf.oosBaselineRate != null ? ` · 永远看涨基准 ${wf.oosBaselineRate}%` : ''),
    );
    lines.push('');
  }
  lines.push(`> ${wf.degraded ? '⚠️' : '✅'} ${wf.summary}`);
  lines.push('');
  lines.push('> Walk-forward 只回答「全样本校准是否自嗨」：测试窗命中率仍是小样本参考，不是业绩承诺。');
  lines.push('');
  return lines.join('\n');
}
