// 评分区间（校准用）—— 纯函数，无外部依赖，便于复用与单元测试

export interface ScoreBucket {
  range: string;
  min: number;
  max: number;
}

/** 校准评分分桶定义（与 calibrate 报告一致） */
export const SCORE_BUCKETS: ScoreBucket[] = [
  { range: '0-30', min: 0, max: 30 },
  { range: '30-50', min: 30, max: 50 },
  { range: '50-60', min: 50, max: 60 },
  { range: '60-70', min: 60, max: 70 },
  { range: '70-80', min: 70, max: 80 },
  { range: '80-90', min: 80, max: 90 },
  { range: '90-100', min: 90, max: 100 },
];

/**
 * 找到评分所属的区间。
 * 区间为左闭右开 [min, max)，但最后一个区间右端为闭区间，
 * 使满分 100 也能正确归入 90-100（修复满分无校准上下文的问题）。
 */
export function scoreBucketRange(score: number): ScoreBucket | null {
  for (const bucket of SCORE_BUCKETS) {
    const isLast = bucket.max === 100;
    const inRange = score >= bucket.min && (isLast ? score <= bucket.max : score < bucket.max);
    if (inRange) return bucket;
  }
  return null;
}
