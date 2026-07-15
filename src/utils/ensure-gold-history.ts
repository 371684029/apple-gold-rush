// 确保本地有足够历史金价 — 分析 / init-history 前自动补齐

import type { GoldPricesRepo } from '../db/gold-prices.js';
import { fetchYahooGoldDailyCloses } from '../data/yahoo-gold-history.js';
import { listMissingLondonDates } from './history-backfill.js';
import { addCalendarDays, todayDate } from './time.js';

/** 技术指标生效所需最少「有 london_close 的交易日」行数 */
export const MIN_TRADING_ROWS_FOR_ANALYSIS = 20;

export interface EnsureHistoryResult {
  filled: number;
  attempted: number;
  tradingRows: number;
  source: 'yahoo' | 'none';
  readyForAnalysis: boolean;
}

/** 统计窗口内有效 london_close 行数（>0） */
export function countLondonRowsInWindow(
  repo: GoldPricesRepo,
  days: number,
  asOf: string = todayDate(),
): number {
  const from = addCalendarDays(asOf, -(days - 1));
  return repo.getRange(from, asOf).filter(r => r.londonClose != null && r.londonClose > 0).length;
}

/**
 * 用 Yahoo GC=F 日线补齐缺失的 london_close（不覆盖已有当日采集数据）。
 * 默认补齐过去 60 个日历日窗口内的交易日。
 */
export async function ensureGoldPriceHistory(
  repo: GoldPricesRepo,
  days = 60,
  asOf: string = todayDate(),
): Promise<EnsureHistoryResult> {
  const missing = listMissingLondonDates(repo, days, asOf);
  const tradingRowsBefore = countLondonRowsInWindow(repo, days, asOf);

  if (missing.length === 0 && tradingRowsBefore >= MIN_TRADING_ROWS_FOR_ANALYSIS) {
    return {
      filled: 0,
      attempted: 0,
      tradingRows: tradingRowsBefore,
      source: 'none',
      readyForAnalysis: true,
    };
  }

  let filled = 0;
  try {
    const rows = await fetchYahooGoldDailyCloses(days, asOf);
    const missingSet = new Set(missing);

    for (const row of rows) {
      if (!missingSet.has(row.date)) continue;
      const existing = repo.getByDate(row.date);
      if (existing?.londonClose != null) continue;

      repo.upsertBackfill({
        date: row.date,
        londonClose: row.londonClose,
        londonHigh: row.londonClose,
        londonLow: row.londonClose,
        shanghaiClose: null,
        shanghaiHigh: null,
        shanghaiLow: null,
        etfNav: null,
        etfChange: null,
        dollarIndex: null,
        us10yYield: null,
        tipsYield: null,
      });
      filled++;
    }
  } catch (err) {
    const tradingRows = countLondonRowsInWindow(repo, days, asOf);
    if (tradingRows >= MIN_TRADING_ROWS_FOR_ANALYSIS) {
      return {
        filled: 0,
        attempted: missing.length,
        tradingRows,
        source: 'none',
        readyForAnalysis: true,
      };
    }
    throw err;
  }

  const tradingRows = countLondonRowsInWindow(repo, days, asOf);
  return {
    filled,
    attempted: missing.length,
    tradingRows,
    source: 'yahoo',
    readyForAnalysis: tradingRows >= MIN_TRADING_ROWS_FOR_ANALYSIS,
  };
}
