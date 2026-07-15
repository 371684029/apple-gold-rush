// 多源实时锚定 — Yahoo 不可达时的零 LLM 兜底（gold-api / LBMA / FRED）

export interface LiveAnchorPrice {
  symbol: string;
  price: number;
  previousClose?: number;
  change: number;
  timestamp: string;
  date: string;
  source: string;
}

const USER_AGENT = 'GoldRush/0.1 (gold research CLI)';

async function fetchJson(url: string, timeoutMs = 15_000): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json,*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchText(url: string, timeoutMs = 20_000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/csv,text/plain,*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** gold-api.com 实时 XAU/USD（服务器实测可达） */
export async function fetchGoldApiLive(): Promise<LiveAnchorPrice | null> {
  const body = await fetchJson('https://api.gold-api.com/price/XAU') as {
    price?: number;
    updatedAt?: string;
  } | null;
  if (!body?.price || !Number.isFinite(body.price) || body.price <= 0) return null;
  const ts = body.updatedAt || new Date().toISOString();
  return {
    symbol: 'XAU',
    price: Math.round(body.price * 100) / 100,
    change: 0,
    timestamp: ts,
    date: ts.slice(0, 10),
    source: 'gold-api.com',
  };
}

/**
 * 新浪财经期货/外汇快照（国内机房可达）。
 * 例：hq.sinajs.cn/list=hf_GC → 纽约黄金
 */
export async function fetchSinaHq(symbol: string): Promise<LiveAnchorPrice | null> {
  const url = `https://hq.sinajs.cn/list=${encodeURIComponent(symbol)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: 'https://finance.sina.com.cn',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    // 新浪可能是 GBK，但数字字段为 ASCII，latin1 即可安全抽价
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('latin1');
    // var hq_str_hf_GC="4033.490,,4033.800,...";
    const m = text.match(/="([^"]*)"/);
    if (!m?.[1]) return null;
    const parts = m[1].split(',');
    const price = parseFloat(parts[0]);
    if (!Number.isFinite(price) || price <= 0) return null;
    // 常见字段：现价,?,买,卖,高,低,...,昨收
    const prev = parseFloat(parts[7] || parts[8] || '') || price;
    const chg = prev > 0 ? ((price - prev) / prev) * 100 : 0;
    const now = new Date().toISOString();
    return {
      symbol,
      price: Math.round(price * 100) / 100,
      previousClose: prev,
      change: Math.round(chg * 100) / 100,
      timestamp: now,
      date: now.slice(0, 10),
      source: `sina ${symbol}`,
    };
  } catch {
    return null;
  }
}

/** LBMA 下午定盘价历史（JSON 数组，末尾为最新） */
export async function fetchLbmaGoldHistory(days = 90): Promise<Array<{ date: string; close: number }>> {
  const body = await fetchJson('https://prices.lbma.org.uk/json/gold_pm.json', 30_000) as
    | Array<{ d?: string; v?: Array<number | null> }>
    | null;
  if (!Array.isArray(body) || body.length === 0) return [];

  const rows: Array<{ date: string; close: number }> = [];
  for (const item of body) {
    const date = item.d;
    const usd = item.v?.[0];
    if (!date || usd == null || !Number.isFinite(usd) || usd <= 0) continue;
    rows.push({ date, close: Math.round(usd * 100) / 100 });
  }
  if (rows.length === 0) return [];
  // 只保留最近 days 日历窗口
  const last = rows[rows.length - 1].date;
  const fromMs = Date.parse(last) - (days - 1) * 86_400_000;
  return rows.filter(r => Date.parse(r.date) >= fromMs);
}

/** FRED CSV 最新有效观测值（HTTP/1.1 兼容由运行时 fetch 处理） */
export async function fetchFredLatest(seriesId: string): Promise<LiveAnchorPrice | null> {
  const text = await fetchText(
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`,
  );
  if (!text || text.includes('<html') || text.includes('error')) return null;

  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  // DATE,VALUE
  for (let i = lines.length - 1; i >= 1; i--) {
    const [date, valRaw] = lines[i].split(',');
    if (!date || !valRaw || valRaw === '.') continue;
    const val = parseFloat(valRaw);
    if (!Number.isFinite(val)) continue;
    return {
      symbol: seriesId,
      price: val,
      change: 0,
      timestamp: new Date().toISOString(),
      date: date.trim(),
      source: `FRED ${seriesId}`,
    };
  }
  return null;
}

/** 聚合：金价 + DXY + 10Y + TIPS（多源瀑布） */
export async function fetchLiveAnchors(): Promise<{
  gold: LiveAnchorPrice | null;
  dxy: LiveAnchorPrice | null;
  us10y: LiveAnchorPrice | null;
  tips: LiveAnchorPrice | null;
}> {
  const [goldApi, sinaGold, dxyFred, dxySina, us10y, tips] = await Promise.all([
    fetchGoldApiLive(),
    fetchSinaHq('hf_GC'),
    fetchFredLatest('DTWEXBGS'),
    fetchSinaHq('DINIW'), // 美元指数
    fetchFredLatest('DGS10'),
    fetchFredLatest('DFII10'),
  ]);

  const gold = goldApi ?? sinaGold;
  const dxy = dxyFred ?? dxySina;

  return { gold, dxy, us10y, tips };
}
