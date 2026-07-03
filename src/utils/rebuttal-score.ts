// 反驳评分修正 — 纯函数，可单测

import type { RebuttalAnalysis, RebuttalStrength } from '../types/analysis.js';

const STRENGTH_MULTIPLIER: Record<RebuttalStrength, number> = {
  weak: 0.10,
  moderate: 0.20,
  strong: 0.35,
};

export interface RebuttalAdjustmentDetail {
  adjustedScore: number;
  netEffect: RebuttalAnalysis['netEffect'];
  bearishImpliedScore: number;
  multiplier: number;
  rawAdjustment: number;
}

/** 计算反驳修正明细（供评分构成展示） */
export function computeRebuttalAdjustment(
  originalScore: number,
  bearScore: number,
  rebuttalStrength: RebuttalStrength,
): RebuttalAdjustmentDetail {
  const multiplier = STRENGTH_MULTIPLIER[rebuttalStrength];
  const bearishImpliedScore = 100 - bearScore;
  const rawAdjustment = (bearishImpliedScore - originalScore) * multiplier;
  const adjustedScore = Math.max(0, Math.min(100, Math.round(originalScore + rawAdjustment)));

  const absAdjust = Math.abs(rawAdjustment);
  let netEffect: RebuttalAnalysis['netEffect'];
  if (absAdjust < 1) {
    netEffect = 'unchanged';
  } else if (rawAdjustment < 0) {
    netEffect = absAdjust < 5 ? 'downgraded' : 'significant_downgrade';
  } else {
    netEffect = 'unchanged';
  }

  return { adjustedScore, netEffect, bearishImpliedScore, multiplier, rawAdjustment };
}

/**
 * 将 bearScore（看空力度，越高越空）映射到与综合分同向的「隐含综合分」，
 * 再按反驳强度向该目标靠拢。
 *
 * 旧公式 (bearScore - originalScore) 在 bearScore > originalScore 时会错误抬高偏多分
 * （例：59 分 + strong 反驳 bear=71 → 63），与 CORRECTNESS-SPEC「反驳压低乐观分」矛盾。
 */
export function adjustScoreWithRebuttal(
  originalScore: number,
  bearScore: number,
  rebuttalStrength: RebuttalStrength,
): { adjustedScore: number; netEffect: RebuttalAnalysis['netEffect'] } {
  const { adjustedScore, netEffect } = computeRebuttalAdjustment(originalScore, bearScore, rebuttalStrength);
  return { adjustedScore, netEffect };
}
