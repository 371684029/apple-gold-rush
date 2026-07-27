// 前瞻收益的唯一口径
//
// 命中率、校准分桶、因子 IC 原先各算各的前瞻收益，窗口并不一致：
//   prediction-track / calibration：close(报告日) → close(T 个交易日后)
//   factor-ic：           close(报告日+1) → close(报告日+1+T)  ← 起点晚一天
// 于是「因子有效性」和「预测准不准」量的其实不是同一段行情，对不上账。
// 全部改走本模块。

import type { GoldPricesRepo } from '../db/gold-prices.js';

/** 有效收盘价：>0 才参与计算，排除脏 0 与缺失 */
export function validClose(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v) && v > 0;
}

export interface ForwardReturnOptions {
  /**
   * 未来交易日不足 T 天时，是否允许用现有的最后一天凑合。
   * 默认 false —— 混用不同长度的窗口会让统计口径变脏。
   */
  allowPartial?: boolean;
  /** allowPartial 为 true 时所需的最少未来交易日 */
  minPartialDays?: number;
}

export interface ForwardReturnResult {
  /** 涨跌幅（%） */
  returnPct: number;
  /** 实际用到的交易日数；等于 T 才是完整窗口 */
  actualDays: number;
  /** 是否为不足 T 天的部分窗口 */
  partial: boolean;
}

/**
 * 报告日收盘 → T 个交易日后收盘的涨跌幅。
 *
 * 起点固定为报告当日收盘（决策发生在收盘价上），终点为其后第 T 个有效交易日。
 */
export function forwardReturn(
  prices: GoldPricesRepo,
  date: string,
  horizonDays: number,
  opts: ForwardReturnOptions = {},
): ForwardReturnResult | null {
  const current = prices.getByDate(date);
  if (!validClose(current?.londonClose)) return null;
  const start = current!.londonClose!;

  // 多取几天做缓冲，因为其中可能夹杂无效收盘
  const after = prices
    .getAfter(date, horizonDays + 10)
    .filter(p => validClose(p.londonClose));

  if (after.length === 0) return null;

  if (after.length >= horizonDays) {
    const end = after[horizonDays - 1].londonClose!;
    return { returnPct: ((end - start) / start) * 100, actualDays: horizonDays, partial: false };
  }

  if (!opts.allowPartial) return null;
  const minDays = opts.minPartialDays ?? Math.min(horizonDays, 3);
  if (after.length < minDays) return null;

  const end = after[after.length - 1].londonClose!;
  return {
    returnPct: ((end - start) / start) * 100,
    actualDays: after.length,
    partial: true,
  };
}

/** 只要涨跌幅的简写 */
export function forwardReturnPct(
  prices: GoldPricesRepo,
  date: string,
  horizonDays: number,
  opts?: ForwardReturnOptions,
): number | null {
  return forwardReturn(prices, date, horizonDays, opts)?.returnPct ?? null;
}
