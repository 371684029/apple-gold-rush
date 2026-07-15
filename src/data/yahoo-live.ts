// Yahoo Finance 实时价格 — 零成本、零 LLM、直接 HTTP 获取
// 作为数据验证的 A 级锚定源；Yahoo 不可达时回落到 gold-api / FRED

import { fetchGoldApiLive, fetchFredLatest, fetchSinaHq } from './live-anchors.js';

const USER_AGENT = 'GoldRush/0.1 (gold research CLI)';

export interface YahooLivePrice {
  symbol: string;
  price: number;        // 最新价
  previousClose: number; // 前收盘（用于计算涨跌幅）
  change: number;       // 涨跌幅 %
  timestamp: string;    // ISO datetime
  date: string;         // YYYY-MM-DD
}

interface YahooQuoteResult {
  meta?: {
    symbol?: string;
    regularMarketPrice?: number;
    previousClose?: number;
    regularMarketTime?: number;
  };
}

interface YahooQuoteResponse {
  quoteResponse?: {
    result?: YahooQuoteResult[];
    error?: { description?: string } | null;
  };
}

interface YahooChartMeta {
  currentTradingPeriod?: {
    regular?: { start?: number; end?: number };
  };
}

interface YahooChartResult {
  meta?: YahooChartMeta;
  timestamp?: number[];
  indicators?: {
    quote?: Array<{
      close?: Array<number | null>;
    }>;
  };
}

interface YahooChartResponse {
  chart?: {
    result?: YahooChartResult[];
    error?: { description?: string } | null;
  };
}

/** 通过 Yahoo Finance Quote API 获取实时报价 */
async function fetchQuote(symbol: string): Promise<YahooLivePrice | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      // Yahoo 在部分机房会长时间挂起，短超时以便快速回落
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) {
      console.warn(`[yahoo-live] ${symbol} quote API 返回 HTTP ${res.status}`);
      return null;
    }

    const body = await res.json() as YahooQuoteResponse;
    const result = body.quoteResponse?.result?.[0];
    if (!result?.meta) {
      console.warn(`[yahoo-live] ${symbol} 无报价数据`);
      return null;
    }

    const { regularMarketPrice, previousClose, regularMarketTime } = result.meta;
    if (regularMarketPrice == null || !Number.isFinite(regularMarketPrice)) {
      console.warn(`[yahoo-live] ${symbol} 报价无效`);
      return null;
    }

    const ts = regularMarketTime ? new Date(regularMarketTime * 1000) : new Date();
    const chg = previousClose && Number.isFinite(previousClose)
      ? ((regularMarketPrice - previousClose) / previousClose) * 100
      : 0;

    return {
      symbol,
      price: Math.round(regularMarketPrice * 100) / 100,
      previousClose: previousClose ?? regularMarketPrice,
      change: Math.round(chg * 100) / 100,
      timestamp: ts.toISOString(),
      date: ts.toISOString().slice(0, 10),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[yahoo-live] ${symbol} 拉取失败: ${msg}`);
    return null;
  }
}

function toYahooShape(p: {
  symbol: string;
  price: number;
  previousClose?: number;
  change: number;
  timestamp: string;
  date: string;
}): YahooLivePrice {
  return {
    symbol: p.symbol,
    price: p.price,
    previousClose: p.previousClose ?? p.price,
    change: p.change,
    timestamp: p.timestamp,
    date: p.date,
  };
}

/** 获取 GC=F 黄金期货最新价；失败则 gold-api / 新浪 */
export async function fetchGoldLive(): Promise<YahooLivePrice | null> {
  const yahoo = await fetchQuote('GC=F');
  if (yahoo) return yahoo;
  const alt = (await fetchGoldApiLive()) ?? (await fetchSinaHq('hf_GC'));
  return alt ? toYahooShape(alt) : null;
}

/** 获取 DXY 美元指数最新价；失败则 FRED DTWEXBGS */
export async function fetchDxyLive(): Promise<YahooLivePrice | null> {
  const yahoo = await fetchQuote('DX-Y.NYB');
  if (yahoo) return yahoo;
  const alt = await fetchFredLatest('DTWEXBGS');
  return alt ? toYahooShape(alt) : null;
}

/** 获取 10Y 美债收益率；失败则 FRED DGS10 */
export async function fetch10YLive(): Promise<YahooLivePrice | null> {
  const yahoo = await fetchQuote('^TNX');
  if (yahoo) return yahoo;
  const alt = await fetchFredLatest('DGS10');
  return alt ? toYahooShape(alt) : null;
}

/** 并行获取全部实时数据 */
export async function fetchAllLive(): Promise<{
  gold: YahooLivePrice | null;
  dxy: YahooLivePrice | null;
  us10y: YahooLivePrice | null;
}> {
  const [gold, dxy, us10y] = await Promise.all([
    fetchGoldLive(),
    fetchDxyLive(),
    fetch10YLive(),
  ]);
  return { gold, dxy, us10y };
}
