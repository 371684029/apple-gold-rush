// Walk-forward 校准卫生 — 用前半段估规则，后半段样本外看偏差
// 禁止「全样本调阈值后再报命中率」的自嗨

import type { CalibrationReport } from '../types/calibration.js';

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
  summary: string;
}

function bucketMae(report: CalibrationReport): number | null {
  const usable = report.buckets.filter(b => b.sampleSize >= 3);
  if (!usable.length) return null;
  const sum = usable.reduce((s, b) => s + Math.abs(b.calibrationError), 0);
  return Math.round((sum / usable.length) * 10) / 10;
}

/**
 * 对比训练窗与测试窗两份校准报告（由调用方按日期切分后分别 compute）
 */
export function summarizeWalkForward(
  train: CalibrationReport,
  test: CalibrationReport,
): WalkForwardSplit {
  const trainMae = bucketMae(train);
  const testMae = bucketMae(test);
  const degraded =
    trainMae != null && testMae != null && testMae > trainMae + 8;

  let summary: string;
  if (trainMae == null || testMae == null) {
    summary = '样本不足，无法做可靠 walk-forward';
  } else if (degraded) {
    summary = `样本外误差变差（训练 MAE ${trainMae}% → 测试 ${testMae}%）：全样本命中率可能偏乐观`;
  } else {
    summary = `样本外尚可（训练 MAE ${trainMae}% → 测试 ${testMae}%）`;
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
    summary,
  };
}

export function formatWalkForwardConsole(wf: WalkForwardSplit, indent = '  '): string {
  return [
    `${indent}🚶 Walk-forward 卫生检查`,
    `${indent}  训练 ${wf.trainFrom}~${wf.trainTo}（${wf.trainBuckets} 桶）MAE ${wf.trainMae ?? 'N/A'}%`,
    `${indent}  测试 ${wf.testFrom}~${wf.testTo}（${wf.testBuckets} 桶）MAE ${wf.testMae ?? 'N/A'}%`,
    `${indent}  ${wf.degraded ? '⚠️' : '✅'} ${wf.summary}`,
  ].join('\n');
}

export function formatWalkForwardMarkdown(wf: WalkForwardSplit): string {
  return [
    '## 🚶 Walk-forward 卫生',
    '',
    `| 窗 | 区间 | 分桶数 | MAE |`,
    `|----|------|--------|-----|`,
    `| 训练 | ${wf.trainFrom} ~ ${wf.trainTo} | ${wf.trainBuckets} | ${wf.trainMae ?? 'N/A'}% |`,
    `| 测试 | ${wf.testFrom} ~ ${wf.testTo} | ${wf.testBuckets} | ${wf.testMae ?? 'N/A'}% |`,
    '',
    `> ${wf.degraded ? '⚠️' : '✅'} ${wf.summary}`,
    '',
  ].join('\n');
}
