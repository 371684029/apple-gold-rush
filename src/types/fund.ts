// 基金面类型定义

/** 支付宝黄金定投跟踪基金代码 */
export const TRACKED_FUNDS = [
  { code: '518880', name: '华安黄金ETF', type: 'ETF' as const },
  { code: '000216', name: '华安黄金ETF联接A', type: 'A' as const },
  { code: '000217', name: '华安黄金ETF联接C', type: 'C' as const },
  { code: '002610', name: '博时黄金ETF联接A', type: 'A' as const },
  { code: '002611', name: '博时黄金ETF联接C', type: 'C' as const },
] as const;

/** 基金类型 */
export type FundClass = 'A' | 'C' | 'ETF';

/** 估值水位 */
export type ValuationLevel = 'low' | 'fair' | 'high';

/** 基金对比项 */
export interface FundComparison {
  code: string;
  name: string;
  type: FundClass;
  nav: number;            // 最新净值
  change1w: number;       // 近1周涨跌 (%)
  change1m: number;       // 近1月涨跌 (%)
  change3m: number;       // 近3月涨跌 (%)
  feeRate: number;        // 综合费率 (%)
  totalCost1y: number;    // 持有1年总成本 (%)
  totalCost3y: number;    // 持有3年总成本 (%)
  scale: number;          // 基金规模 (亿)
  recommendation: string; // 适用场景
}

/** 基金推荐 */
export interface FundRecommendation {
  longTerm: string;       // 长期持有推荐品种
  mediumTerm: string;     // 中期波段推荐品种
  dipBuy: string;         // 定投推荐品种
}

/** 估值判断 */
export interface Valuation {
  level: ValuationLevel;
  indicator: string;
  action: string;         // 定投操作建议
}

/** 溢价折价 */
export interface PremiumDiscount {
  current: number;        // 当前溢价/折价率 (%)
  trend: string;
  advice: string;         // 买入/回避建议
}

/** 基金面分析结果 */
export interface FundAnalysis {
  funds?: FundComparison[];
  recommendation: FundRecommendation;
  valuation: Valuation;
  premiumDiscount: PremiumDiscount;
}

/** 基金净值存储记录 */
export interface FundNavRecord {
  date: string;
  code: string;
  nav: number;
  accNav: number;
  changePct: number;
  premium: number | null;
  createdAt: string;
}
