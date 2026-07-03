// 基金净值区间涨跌 — 基于 fund_nav 本地序列

import type { FundNavRecord } from '../types/fund.js';
import { addCalendarDays } from './time.js';

/** 近 N 个自然日前的净值涨跌幅（%），数据不足返回 null */
export function pctChangeSince(records: FundNavRecord[], daysAgo: number): number | null {
  if (records.length < 2) return null;
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1];
  const targetDate = addCalendarDays(latest.date, -daysAgo);
  const base = sorted.filter(r => r.date <= targetDate).pop();
  if (!base || base.nav <= 0) return null;
  return ((latest.nav - base.nav) / base.nav) * 100;
}
