// 历史百分位计算

/**
 * 计算数值在历史数据中的百分位
 * 返回当前值在历史序列中处于什么位置（0-100）
 */
export function percentile(currentValue: number, historicalData: number[]): number {
  if (historicalData.length === 0) return 50;

  const sorted = [...historicalData].sort((a, b) => a - b);
  let below = 0;
  let equal = 0;

  for (const val of sorted) {
    if (val < currentValue) below++;
    else if (val === currentValue) equal++;
  }

  // 使用线性插值
  if (equal === 0) {
    // 当前值不在历史数据中
    return (below / sorted.length) * 100;
  }

  // 当前值在历史数据中，取中间位置
  return ((below + equal / 2) / sorted.length) * 100;
}

/**
 * 计算滚动百分位
 * 返回每个时间点的值在过去 N 天中的百分位
 */
export function rollingPercentile(data: number[], window: number): (number | null)[] {
  const result: (number | null)[] = [];

  for (let i = 0; i < data.length; i++) {
    if (i < window - 1) {
      result.push(null);
      continue;
    }

    const windowData = data.slice(i - window + 1, i + 1);
    const p = percentile(data[i], windowData);
    result.push(p);
  }

  return result;
}

/** 判断估值水位 */
export function valuationLevel(percentileValue: number): 'low' | 'fair' | 'high' {
  if (percentileValue <= 30) return 'low';
  if (percentileValue >= 70) return 'high';
  return 'fair';
}

/** 计算金价偏离均线百分比 */
export function deviationFromMA(data: number[], period: number = 20): (number | null)[] {
  const result: (number | null)[] = [];

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += data[j];
    }
    const ma = sum / period;
    const dev = ((data[i] - ma) / ma) * 100;
    result.push(dev);
  }

  return result;
}
