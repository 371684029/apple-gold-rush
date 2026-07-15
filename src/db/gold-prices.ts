// 金价快照 CRUD
import Database from 'better-sqlite3';
import type { GoldPriceRecord } from '../types/market.js';
import { addCalendarDays, todayDate } from '../utils/time.js';

export class GoldPricesRepo {
  constructor(private db: Database.Database) {}

  /** 将 ≤0 视为缺失，避免 0 覆盖有效历史价 */
  private static sanitize(v: number | null | undefined): number | null {
    if (v == null || !Number.isFinite(v) || v === 0) return null;
    return v;
  }

  /** 插入或更新当日金价快照（0/无效值不覆盖已有有效列） */
  upsert(record: Omit<GoldPriceRecord, 'createdAt'>): void {
    const londonClose = GoldPricesRepo.sanitize(record.londonClose);
    const londonHigh = GoldPricesRepo.sanitize(record.londonHigh);
    const londonLow = GoldPricesRepo.sanitize(record.londonLow);
    const shanghaiClose = GoldPricesRepo.sanitize(record.shanghaiClose);
    const shanghaiHigh = GoldPricesRepo.sanitize(record.shanghaiHigh);
    const shanghaiLow = GoldPricesRepo.sanitize(record.shanghaiLow);
    const etfNav = GoldPricesRepo.sanitize(record.etfNav);
    const dollarIndex = GoldPricesRepo.sanitize(record.dollarIndex);
    const us10yYield = GoldPricesRepo.sanitize(record.us10yYield);
    // tips 可为负，仅拒绝恰好 0 / 非有限
    const tipsYield = record.tipsYield != null && Number.isFinite(record.tipsYield) && record.tipsYield !== 0
      ? record.tipsYield
      : null;

    this.db.prepare(`
      INSERT INTO gold_prices (date, london_close, london_high, london_low,
        shanghai_close, shanghai_high, shanghai_low, etf_nav, etf_change,
        dollar_index, us10y_yield, tips_yield)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        london_close = COALESCE(excluded.london_close, gold_prices.london_close),
        london_high = COALESCE(excluded.london_high, gold_prices.london_high),
        london_low = COALESCE(excluded.london_low, gold_prices.london_low),
        shanghai_close = COALESCE(excluded.shanghai_close, gold_prices.shanghai_close),
        shanghai_high = COALESCE(excluded.shanghai_high, gold_prices.shanghai_high),
        shanghai_low = COALESCE(excluded.shanghai_low, gold_prices.shanghai_low),
        etf_nav = COALESCE(excluded.etf_nav, gold_prices.etf_nav),
        etf_change = COALESCE(excluded.etf_change, gold_prices.etf_change),
        dollar_index = COALESCE(excluded.dollar_index, gold_prices.dollar_index),
        us10y_yield = COALESCE(excluded.us10y_yield, gold_prices.us10y_yield),
        tips_yield = COALESCE(excluded.tips_yield, gold_prices.tips_yield)
    `).run(
      record.date, londonClose, londonHigh, londonLow,
      shanghaiClose, shanghaiHigh, shanghaiLow,
      etfNav, record.etfChange ?? null, dollarIndex,
      us10yYield, tipsYield,
    );
  }

  /** 历史回填：仅填充 NULL 字段，不覆盖已有实时采集数据 */
  upsertBackfill(record: Omit<GoldPriceRecord, 'createdAt'>): void {
    this.db.prepare(`
      INSERT INTO gold_prices (date, london_close, london_high, london_low,
        shanghai_close, shanghai_high, shanghai_low, etf_nav, etf_change,
        dollar_index, us10y_yield, tips_yield)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        london_close = COALESCE(gold_prices.london_close, excluded.london_close),
        london_high = COALESCE(gold_prices.london_high, excluded.london_high),
        london_low = COALESCE(gold_prices.london_low, excluded.london_low),
        shanghai_close = COALESCE(gold_prices.shanghai_close, excluded.shanghai_close),
        shanghai_high = COALESCE(gold_prices.shanghai_high, excluded.shanghai_high),
        shanghai_low = COALESCE(gold_prices.shanghai_low, excluded.shanghai_low),
        etf_nav = COALESCE(gold_prices.etf_nav, excluded.etf_nav),
        etf_change = COALESCE(gold_prices.etf_change, excluded.etf_change),
        dollar_index = COALESCE(gold_prices.dollar_index, excluded.dollar_index),
        us10y_yield = COALESCE(gold_prices.us10y_yield, excluded.us10y_yield),
        tips_yield = COALESCE(gold_prices.tips_yield, excluded.tips_yield)
    `).run(
      record.date, record.londonClose, record.londonHigh, record.londonLow,
      record.shanghaiClose, record.shanghaiHigh, record.shanghaiLow,
      record.etfNav, record.etfChange, record.dollarIndex,
      record.us10yYield, record.tipsYield,
    );
  }

  /** 获取指定日期金价 */
  getByDate(date: string): GoldPriceRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM gold_prices WHERE date = ?`).get(date) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** 获取最近 N 个日历日窗口内的金价（按上海日历截止日） */
  getRecent(days: number, asOf: string = todayDate()): GoldPriceRecord[] {
    const from = addCalendarDays(asOf, -(days - 1));
    return this.getRange(from, asOf);
  }

  /** 获取指定日期区间的金价 */
  getRange(from: string, to: string): GoldPriceRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM gold_prices
      WHERE date >= ? AND date <= ?
      ORDER BY date ASC
    `).all(from, to) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  /** 获取指定日期之后的金价（用于回测） */
  getAfter(date: string, limit: number = 30): GoldPriceRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM gold_prices
      WHERE date > ?
      ORDER BY date ASC
      LIMIT ?
    `).all(date, limit) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  /** 获取总记录数 */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM gold_prices`).get() as { cnt: number };
    return row.cnt;
  }
}

/** 读库时把历史脏数据 0 当成 NULL（tips 允许负） */
function mapNum(v: unknown, allowNegative = false): number | null {
  if (v == null || typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v === 0) return null;
  if (!allowNegative && v < 0) return null;
  return v;
}

function mapRow(row: Record<string, unknown>): GoldPriceRecord {
  return {
    date: row.date as string,
    londonClose: mapNum(row.london_close),
    londonHigh: mapNum(row.london_high),
    londonLow: mapNum(row.london_low),
    shanghaiClose: mapNum(row.shanghai_close),
    shanghaiHigh: mapNum(row.shanghai_high),
    shanghaiLow: mapNum(row.shanghai_low),
    etfNav: mapNum(row.etf_nav),
    etfChange: row.etf_change as number | null,
    dollarIndex: mapNum(row.dollar_index),
    us10yYield: mapNum(row.us10y_yield),
    tipsYield: mapNum(row.tips_yield, true),
    createdAt: row.created_at as string,
  };
}
