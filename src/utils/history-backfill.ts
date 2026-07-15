// 历史金价回填 — 列出缺失日、校验 LLM 提取行

import type { GoldPricesRepo } from '../db/gold-prices.js';
import { addCalendarDays, todayDate } from './time.js';

export interface HistoryPriceRow {
  date: string;
  londonClose: number;
  shanghaiClose?: number | null;
  volume?: number | null;               // COMEX GC=F 日成交量
}

/** 过去 days 个日历日（含 asOf）中 london_close 缺失的日期，升序 */
export function listMissingLondonDates(
  repo: GoldPricesRepo,
  days: number,
  asOf: string = todayDate(),
): string[] {
  const missing: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addCalendarDays(asOf, -i);
    const row = repo.getByDate(d);
    // 0 视为缺失（历史脏数据 / LLM 占位）
    if (!row || row.londonClose == null || row.londonClose <= 0) {
      missing.push(d);
    }
  }
  return missing;
}

/** 过滤并规范化 LLM 提取的历史行（仅保留目标日、合法数值） */
export function normalizeHistoryRows(
  rows: HistoryPriceRow[],
  allowedDates: Set<string>,
): HistoryPriceRow[] {
  const out: HistoryPriceRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row?.date || !allowedDates.has(row.date) || seen.has(row.date)) continue;
    if (typeof row.londonClose !== 'number' || !Number.isFinite(row.londonClose) || row.londonClose <= 0) {
      continue;
    }
    seen.add(row.date);
    out.push({
      date: row.date,
      londonClose: row.londonClose,
      shanghaiClose: row.shanghaiClose ?? null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
