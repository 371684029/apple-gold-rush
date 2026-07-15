// Yahoo Finance 历史金价 — COMEX 黄金期货 GC=F 日线收盘（无需 API Key）
// Yahoo 超时/阻断时回落 LBMA 下午定盘价

import { addCalendarDays, todayDate } from '../utils/time.js';
import type { HistoryPriceRow } from '../utils/history-backfill.js';
import { fetchLbmaGoldHistory } from './live-anchors.js';

const USER_AGENT = 'GoldRush/0.1 (gold research CLI)';
const SYMBOL = 'GC=F';

interface YahooChartResult {
  timestamp?: number[];
  indicators?: {
    quote?: Array<{
      close?: Array<number | null>;
      high?: Array<number | null>;
      low?: Array<number | null>;
      volume?: Array<number | null>;
    }>;
  };
}

interface YahooChartResponse {
  chart?: {
    result?: YahooChartResult[];
    error?: { description?: string };
  };
}

/** Yahoo range 参数 */
function rangeForDays(calendarDays: number): string {
  if (calendarDays <= 35) return '1mo';
  if (calendarDays <= 95) return '3mo';
  if (calendarDays <= 185) return '6mo';
  return '1y';
}

/** Unix 秒 → YYYY-MM-DD（按 America/New_York 交易日历） */
export function yahooTimestampToDate(ts: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts * 1000));
  return parts; // en-CA → YYYY-MM-DD
}

/**
 * 从 Yahoo Finance 拉取 GC=F 日线收盘价。
 * @param calendarDays 需要的日历跨度（用于选择 range）
 * @param asOf 截止日期（上海日历日）
 */
export async function fetchYahooGoldDailyCloses(
  calendarDays: number,
  asOf: string = todayDate(),
): Promise<HistoryPriceRow[]> {
  try {
    const rows = await fetchYahooChartCloses(calendarDays, asOf);
    if (rows.length > 0) return rows;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[yahoo-gold-history] Yahoo 失败，回落 LBMA: ${msg}`);
  }

  // LBMA 下午定盘价（服务器实测可达）
  const lbma = await fetchLbmaGoldHistory(calendarDays + 10);
  const from = addCalendarDays(asOf, -(calendarDays - 1));
  return lbma
    .filter(r => r.date >= from && r.date <= asOf)
    .map(r => ({
      date: r.date,
      londonClose: r.close,
      shanghaiClose: null,
      volume: null,
    }));
}

async function fetchYahooChartCloses(
  calendarDays: number,
  asOf: string,
): Promise<HistoryPriceRow[]> {
  const range = rangeForDays(calendarDays);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOL)}?interval=1d&range=${range}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance 请求失败: HTTP ${res.status}`);
  }

  const body = await res.json() as YahooChartResponse;
  const err = body.chart?.error?.description;
  if (err) {
    throw new Error(`Yahoo Finance: ${err}`);
  }

  const result = body.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  const closes = quote?.close ?? [];
  const volumes = quote?.volume ?? [];

  const from = addCalendarDays(asOf, -(calendarDays - 1));
  const rows: HistoryPriceRow[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null || !Number.isFinite(close) || close <= 0) continue;

    const date = yahooTimestampToDate(timestamps[i]);
    if (date < from || date > asOf) continue;

    rows.push({
      date,
      londonClose: Math.round(close * 100) / 100,
      shanghaiClose: null,
      volume: volumes[i] ?? null,
    });
  }

  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/** 解析 Yahoo JSON（供单测） */
export function parseYahooChartResponse(
  body: YahooChartResponse,
  from: string,
  to: string,
): HistoryPriceRow[] {
  const result = body.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const volumes = result?.indicators?.quote?.[0]?.volume ?? [];
  const rows: HistoryPriceRow[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null || !Number.isFinite(close) || close <= 0) continue;
    const date = yahooTimestampToDate(timestamps[i]);
    if (date < from || date > to) continue;
    rows.push({ date, londonClose: close, shanghaiClose: null, volume: volumes[i] ?? null });
  }
  return rows;
}
