// GLD ETF 持仓 — 多源：Yahoo → 东财新闻(SPDR吨数) → 新浪价格辅助
//
// 现网：Yahoo 常超时；东财「SPDR黄金持仓」新闻含「当前持仓量 XXX 吨」可解析。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EtfHoldings } from '../types/institutional.js';
import { searchEastmoneyArticles } from './eastmoney-search.js';
import { fetchSinaHq } from './live-anchors.js';

const execFileP = promisify(execFile);
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const OZ_PER_SHARE = 0.094;
const OZ_PER_TON = 32150.746;

async function curlJson(url: string): Promise<unknown | null> {
  try {
    const { stdout } = await execFileP('curl', [
      '-sS', '-L', '-f',
      '-H', `User-Agent: ${USER_AGENT}`,
      '-H', 'Accept: application/json,*/*',
      '--max-time', '12',
      '--output', '-',
      url,
    ], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
    });
    if (!stdout || stdout.startsWith('<!')) return null;
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json,*/*',
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchJsonDual(url: string): Promise<unknown | null> {
  const a = await fetchJson(url);
  if (a) return a;
  return curlJson(url);
}

function estimateGoldTons(sharesOutstanding: number): number {
  if (sharesOutstanding <= 0) return 0;
  return (sharesOutstanding * OZ_PER_SHARE) / OZ_PER_TON;
}

/** 从新闻文本解析 SPDR/GLD 持仓吨数 */
export function parseGldHoldingsFromText(text: string): {
  tons: number;
  change: number | null;
  asOf: string | null;
  evidence: string;
} | null {
  if (!text) return null;
  const plain = text.replace(/<[^>]+>/g, '');

  // 当前持仓量为1002.449吨 / 持仓量 1005.36 吨
  const tonM = plain.match(
    /(?:当前)?持仓量[为是]?\s*(\d{3,5}(?:\.\d+)?)\s*吨|持仓\s*(\d{3,5}(?:\.\d+)?)\s*吨/,
  );
  if (!tonM) return null;
  const tons = parseFloat(tonM[1] || tonM[2]);
  // GLD 近年约 800–1200 吨量级
  if (!Number.isFinite(tons) || tons < 500 || tons > 2000) return null;

  let change: number | null = null;
  const ch = plain.match(/减少\s*(\d+(?:\.\d+)?)\s*吨|增加\s*(\d+(?:\.\d+)?)\s*吨/);
  if (ch) {
    if (ch[1]) change = -parseFloat(ch[1]);
    else if (ch[2]) change = parseFloat(ch[2]);
  }
  // 较前一日减少3.199吨
  const ch2 = plain.match(/较前[一]?[日个交易日]*\s*(?:减少|增加)\s*(\d+(?:\.\d+)?)\s*吨/);
  if (ch2 && change == null) {
    const n = parseFloat(ch2[1]);
    change = plain.includes('减少') ? -n : n;
  }

  let asOf: string | null = null;
  const d1 = plain.match(/截至\s*(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/);
  const d2 = plain.match(/截至\s*(\d{1,2})月(\d{1,2})日/);
  if (d1) {
    asOf = `${d1[1]}-${d1[2].padStart(2, '0')}-${d1[3].padStart(2, '0')}`;
  } else if (d2) {
    const y = new Date().getFullYear();
    asOf = `${y}-${d2[1].padStart(2, '0')}-${d2[2].padStart(2, '0')}`;
  }

  return { tons, change, asOf, evidence: tonM[0] };
}

/** 东财新闻 → 多条 GLD 吨数（用于历史样本，满足 flow≥5 门槛） */
async function fetchGldSeriesFromEastmoney(): Promise<EtfHoldings[]> {
  const keywords = ['SPDR黄金持仓', '全球最大黄金ETF持仓', 'SPDR Gold Trust持仓'];
  const byDate = new Map<string, EtfHoldings>();

  let sinaPrice: number | null = null;
  try {
    const sina = await fetchSinaHq('gb_gld');
    if (sina?.price) sinaPrice = sina.price;
  } catch { /* ignore */ }

  for (const kw of keywords) {
    const arts = await searchEastmoneyArticles(kw, 12);
    for (const art of arts) {
      const blob = `${art.title} ${art.content}`;
      if (!/SPDR|GLD|黄金ETF|Gold Trust/.test(blob)) continue;
      const parsed = parseGldHoldingsFromText(blob);
      if (!parsed) continue;

      const date = parsed.asOf
        ?? (/^\d{4}-\d{2}-\d{2}$/.test(art.date) ? art.date : '');
      if (!date) continue;

      let gldAum = 0;
      if (sinaPrice && parsed.tons > 0) {
        const shares = (parsed.tons * OZ_PER_TON) / OZ_PER_SHARE;
        gldAum = Math.round((shares * sinaPrice) / 1e6 * 100) / 100;
      }

      // 同日保留最新解析
      byDate.set(date, {
        date,
        gldTons: Math.round(parsed.tons * 1000) / 1000,
        gldChange: parsed.change ?? 0,
        gldAum,
      });
    }
  }

  const list = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (list.length) {
    const last = list[list.length - 1];
    console.log(
      `  ⚓ GLD 持仓: ${last.gldTons} 吨`
      + (last.gldChange ? ` (Δ${last.gldChange > 0 ? '+' : ''}${last.gldChange})` : '')
      + ` @ ${last.date}（共解析 ${list.length} 个交易日）`,
    );
  }
  return list;
}

async function fetchGldFromEastmoney(): Promise<EtfHoldings | null> {
  const series = await fetchGldSeriesFromEastmoney();
  return series.length ? series[series.length - 1] : null;
}

interface GldMeta {
  price: number;
  prevClose: number;
  marketCap: number;
  sharesOutstanding: number;
}

async function fetchGldMetaFromYahoo(): Promise<GldMeta | null> {
  const chartUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/GLD?interval=1d&range=5d';
  const summaryUrl =
    'https://query1.finance.yahoo.com/v10/finance/quoteSummary/GLD?modules=price,defaultKeyStatistics';

  const [chart, summary] = await Promise.all([
    fetchJsonDual(chartUrl),
    fetchJsonDual(summaryUrl),
  ]);

  const chartResult = (chart as any)?.chart?.result?.[0];
  const meta = chartResult?.meta;
  const price = meta?.regularMarketPrice;
  const prevClose = meta?.chartPreviousClose ?? meta?.previousClose ?? price;
  if (price == null || !Number.isFinite(price) || price <= 0) return null;

  const result = (summary as any)?.quoteSummary?.result?.[0];
  const shares = result?.defaultKeyStatistics?.sharesOutstanding?.raw
    ?? result?.defaultKeyStatistics?.sharesOutstanding;
  const sharesOutstanding = typeof shares === 'number' ? shares : 0;
  const marketCap = sharesOutstanding > 0 ? price * sharesOutstanding : 0;

  return {
    price,
    prevClose: prevClose ?? price,
    marketCap,
    sharesOutstanding,
  };
}

/** 返回最新 GLD 持仓（优先真实吨数） */
export async function fetchLatestGldHolding(): Promise<EtfHoldings | null> {
  const series = await fetchGldHoldings();
  return series.length ? series[series.length - 1] : null;
}

/** 获取 GLD 持仓列表（含东财多日回填，供 flow 信号） */
export async function fetchGldHoldings(): Promise<EtfHoldings[]> {
  // 1) 东财新闻多日
  try {
    const em = await fetchGldSeriesFromEastmoney();
    if (em.length > 0) return em;
  } catch (err) {
    console.warn('[etf-grabber] 东财 GLD 解析失败:', err instanceof Error ? err.message : err);
  }

  // 2) Yahoo 份额估算（单日）
  const meta = await fetchGldMetaFromYahoo();
  if (meta && meta.sharesOutstanding > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const gldTons = estimateGoldTons(meta.sharesOutstanding);
    console.log(`  ⚓ GLD 持仓(Yahoo估算): ${gldTons.toFixed(2)} 吨`);
    return [{
      date: today,
      gldTons: Math.round(gldTons * 100) / 100,
      gldChange: 0,
      gldAum: Math.round(meta.marketCap / 1e6 * 100) / 100,
    }];
  }

  console.warn('[etf-grabber] Yahoo / 东财均未拿到 GLD 持仓吨数');
  return [];
}
