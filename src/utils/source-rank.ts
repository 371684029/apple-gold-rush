// 来源分级 + 交叉验证工具

import type { SourceGrade, ValidationResult, ValidationSource, ValidationConsensus } from '../types/market.js';

/** 已知来源分级映射 */
const SOURCE_GRADES: Record<string, SourceGrade> = {
  // A级（权威）
  '上海黄金交易所': 'A',
  'COMEX': 'A',
  'CME': 'A',
  'Federal Reserve': 'A',
  '美联储': 'A',
  '世界黄金协会': 'A',
  'World Gold Council': 'A',
  'BIS': 'A',
  'IMF': 'A',

  // B级（可信）
  '金十数据': 'B',
  '东方财富': 'B',
  'Wind': 'B',
  '华尔街见闻': 'B',
  '财联社': 'B',
  '证券时报': 'B',
  '上海证券报': 'B',
  'Investing.com': 'B',
  'Bloomberg': 'B',
  'Reuters': 'B',
  '路透': 'B',
  'Financial Times': 'B',
  'Kitco': 'B',
  'TradingView': 'B',

  // C级（参考）
  '雪球': 'C',
  '微博': 'C',
  '知乎': 'C',
  '贴吧': 'C',
  '头条': 'C',
  '微信公众号': 'C',
};

/** 判断来源可信度等级 */
export function gradeSource(sourceName: string): SourceGrade {
  // 直接匹配
  if (SOURCE_GRADES[sourceName]) {
    return SOURCE_GRADES[sourceName];
  }

  // 模糊匹配
  for (const [key, grade] of Object.entries(SOURCE_GRADES)) {
    if (sourceName.includes(key) || key.includes(sourceName)) {
      return grade;
    }
  }

  // 未知来源默认B级
  return 'B';
}

/** 交叉验证多个来源的数据 */
export function crossValidate(
  field: string,
  sources: ValidationSource[],
  tolerancePct: number = 1,
): ValidationResult {
  if (sources.length === 0) {
    return {
      field,
      sources,
      consensus: 'major_conflict',
      finalValue: 0,
      confidence: 0,
    };
  }

  if (sources.length === 1) {
    return {
      field,
      sources,
      consensus: 'verified',
      finalValue: sources[0].value,
      confidence: 70, // 单源默认70%置信度
    };
  }

  // 数值型验证
  const numericValues = sources
    .filter(s => typeof s.value === 'number')
    .map(s => s.value as number);

  if (numericValues.length < 2) {
    return {
      field,
      sources,
      consensus: 'verified',
      finalValue: sources[0].value,
      confidence: 60,
    };
  }

  const avg = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
  const maxDeviation = Math.max(...numericValues.map(v => Math.abs((v - avg) / avg * 100)));

  let consensus: ValidationConsensus;
  let finalValue: number | string;
  let confidence: number;

  if (maxDeviation < 0.5) {
    // 3源一致或偏差极小
    consensus = 'verified';
    finalValue = avg;
    confidence = 95;
  } else if (maxDeviation < tolerancePct) {
    // 2源一致，1源偏差 < 阈值
    consensus = 'minor_deviation';
    finalValue = avg;
    confidence = 80;
  } else {
    // 3源差异 > 阈值
    consensus = 'major_conflict';
    // 取A级来源的值，或平均值
    const aGradeSources = sources.filter(s => s.grade === 'A');
    finalValue = aGradeSources.length > 0
      ? (aGradeSources[0].value as number)
      : avg;
    confidence = 50;
  }

  return { field, sources, consensus, finalValue, confidence };
}

/** 判断数据时效性 */
export function checkFreshness(dataTime: string, thresholdHours: number = 4): { fresh: boolean; ageHours: number; warning?: string } {
  const dataDate = new Date(dataTime);

  // 非法时间戳：视为不新鲜并提示，避免 NaN 比较被误判为 fresh
  if (Number.isNaN(dataDate.getTime())) {
    return {
      fresh: false,
      ageHours: 0,
      warning: `⚠️ 数据时间戳无效（${dataTime || '空'}），无法判断时效性`,
    };
  }

  const now = new Date();
  const ageMs = now.getTime() - dataDate.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  if (ageHours > thresholdHours) {
    return {
      fresh: false,
      ageHours: Math.round(ageHours * 10) / 10,
      warning: `⚠️ 数据已过 ${Math.round(ageHours)} 小时，可能过时`,
    };
  }

  return { fresh: true, ageHours: Math.round(ageHours * 10) / 10 };
}
