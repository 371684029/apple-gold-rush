// 校准数值修正 — 将历史命中率转化为分数偏移

import type { CalibrationContext, Direction } from '../types/analysis.js';
import { scoreBucketRange } from './score-buckets.js';

export interface CalibrationAdjustResult {
  rawScore: number;
  calibratedScore: number;
  offset: number;
  applied: boolean;
  reason: string;
}

/** 根据评分区间中点与实际上涨概率计算偏移（负=下调偏多预期） */
export function computeCalibrationOffset(
  rawScore: number,
  historicalAccuracy: number | null,
  sampleSize: number,
): number {
  if (historicalAccuracy == null || sampleSize < 3) return 0;

  const bucket = scoreBucketRange(rawScore);
  if (!bucket) return 0;

  const midScore = (bucket.min + bucket.max) / 2;
  const actualProbPct = historicalAccuracy * 100;
  let offset = actualProbPct - midScore;

  const scale = sampleSize >= 10 ? 1 : sampleSize >= 5 ? 0.5 : sampleSize >= 3 ? 0.35 : 0;
  if (scale === 0) return 0;
  offset = Math.round(offset * scale);

  return Math.max(-8, Math.min(3, offset));
}

export function applyCalibrationScore(
  rawScore: number,
  ctx: Pick<
    CalibrationContext,
    | 'historicalAccuracy'
    | 'sampleSize'
    | 'systematicBias'
    | 'regimeHistoricalAccuracy'
    | 'regimeSampleSize'
    | 'regimeSystematicBias'
  > | null,
  preferRegime = true,
): CalibrationAdjustResult {
  const clampedRaw = Math.max(0, Math.min(100, Math.round(rawScore)));

  let accuracy = ctx?.historicalAccuracy ?? null;
  let sampleSize = ctx?.sampleSize ?? 0;
  let biasLabel = ctx?.systematicBias ?? '样本不足';

  if (
    preferRegime
    && ctx?.regimeSampleSize != null
    && ctx.regimeSampleSize >= 3
    && ctx.regimeHistoricalAccuracy != null
  ) {
    accuracy = ctx.regimeHistoricalAccuracy;
    sampleSize = ctx.regimeSampleSize;
    biasLabel = ctx.regimeSystematicBias ?? biasLabel;
  }

  if (accuracy == null || sampleSize < 3) {
    return {
      rawScore: clampedRaw,
      calibratedScore: clampedRaw,
      offset: 0,
      applied: false,
      reason: sampleSize < 5 ? '校准样本不足' : '暂无校准数据',
    };
  }

  const offset = computeCalibrationOffset(clampedRaw, accuracy, sampleSize);
  const calibratedScore = Math.max(0, Math.min(100, clampedRaw + offset));

  return {
    rawScore: clampedRaw,
    calibratedScore,
    offset,
    applied: offset !== 0,
    reason: offset < 0
      ? `区间偏乐观，下调 ${Math.abs(offset)} 分`
      : offset > 0
        ? `区间偏保守，上调 ${offset} 分`
        : '区间校准良好',
  };
}

/** 由校准后分数推导方向（与长期展望阈值一致） */
export function directionFromScore(score: number): Direction {
  if (score >= 58) return 'bullish';
  if (score <= 42) return 'bearish';
  return 'neutral';
}
