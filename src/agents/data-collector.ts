// 数据采集 Agent — Tavily 搜索 + 结构化提取 + SQLite 快照

import { BaseAgent } from './base.js';
import { getConfig } from '../utils/config.js';
import { getDb } from '../db/index.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import { FundNavRepo } from '../db/fund-nav.js';
import { SearchCacheRepo } from '../db/search-cache.js';
import { SearchRouter } from '../data/search-router.js';
import { todayDate, formatNow } from '../utils/time.js';
import { listMissingLondonDates, normalizeHistoryRows, type HistoryPriceRow } from '../utils/history-backfill.js';
import { TRACKED_FUNDS } from '../types/fund.js';
import type { MarketData, SearchResult } from '../types/market.js';

const PRICE_COLLECT_PROMPT = `你是黄金市场数据采集专家。你的任务是从搜索结果中提取结构化的金价数据。

## 信息可靠性规则（必须遵守）

1. 严禁捏造数据，只使用搜索到的真实数据
2. 每个关键数据点至少搜索2-3个不同来源交叉验证
3. 来源分级：
   - A级（权威）：交易所、央行 → 直接采信
   - B级（可信）：金十、东方财富、华尔街见闻 → 采信但标注来源
   - C级（参考）：自媒体、论坛 → 仅作情绪参考
4. 所有数据必须标注获取时间和来源
5. 多来源数据差异>1%时，标注 ⚠️ 提醒

## 输出要求

- london.price / shanghai.price 为主报价
- london.altPrices / shanghai.altPrices 为其他独立来源报价（最多2条，无则空数组）
- 如果某个字段找不到数据，设为 null，不要编造`;

const SOURCED_PRICE_SCHEMA = {
  type: 'object',
  properties: {
    value: { type: 'number' },
    change: { type: 'number' },
    source: { type: 'string' },
    sourceGrade: { type: 'string' },
    verifiedAt: { type: 'string' },
  },
};

const MARKET_DATA_SCHEMA = {
  type: 'object',
  properties: {
    timestamp: { type: 'string' },
    london: {
      type: 'object',
      properties: {
        price: SOURCED_PRICE_SCHEMA,
        altPrices: { type: 'array', items: SOURCED_PRICE_SCHEMA },
        high: { type: 'object', properties: { value: { type: 'number' }, source: { type: 'string' }, sourceGrade: { type: 'string' }, verifiedAt: { type: 'string' } } },
        low: { type: 'object', properties: { value: { type: 'number' }, source: { type: 'string' }, sourceGrade: { type: 'string' }, verifiedAt: { type: 'string' } } },
      },
    },
    shanghai: {
      type: 'object',
      properties: {
        price: SOURCED_PRICE_SCHEMA,
        altPrices: { type: 'array', items: SOURCED_PRICE_SCHEMA },
        high: { type: 'object', properties: { value: { type: 'number' }, source: { type: 'string' }, sourceGrade: { type: 'string' }, verifiedAt: { type: 'string' } } },
        low: { type: 'object', properties: { value: { type: 'number' }, source: { type: 'string' }, sourceGrade: { type: 'string' }, verifiedAt: { type: 'string' } } },
      },
    },
    etf: {
      type: 'object',
      properties: {
        code: { type: 'string' }, name: { type: 'string' },
        nav: SOURCED_PRICE_SCHEMA,
        premiumDiscount: { type: 'object', properties: { value: { type: 'number' }, source: { type: 'string' }, sourceGrade: { type: 'string' }, verifiedAt: { type: 'string' } } },
      },
    },
    dollarIndex: {
      type: 'object',
      properties: {
        value: SOURCED_PRICE_SCHEMA,
      },
    },
    usTreasury: {
      type: 'object',
      properties: {
        yield10y: SOURCED_PRICE_SCHEMA,
        tips: { type: 'object', properties: { value: { type: 'number' }, source: { type: 'string' }, sourceGrade: { type: 'string' }, verifiedAt: { type: 'string' } } },
      },
    },
  },
  required: ['timestamp', 'london', 'shanghai', 'etf', 'dollarIndex', 'usTreasury'],
};

export class DataCollectorAgent extends BaseAgent {
  private searchRouter: SearchRouter;

  constructor() {
    const config = getConfig();
    super({
      name: 'data-collector',
      model: config.models.dataCollector,
      systemPrompt: PRICE_COLLECT_PROMPT,
    });
    const db = getDb();
    const cache = new SearchCacheRepo(db, config.search.cacheMinutes);
    this.searchRouter = new SearchRouter(config.search.tavilyApiKey, { cache });
  }

  /** 采集市场数据 */
  async collectMarketData(): Promise<MarketData> {
    const year = new Date().getFullYear();
    const searches = [
      { query: `gold price XAUUSD spot today ${year}`, dataType: 'xauusd' },
      { query: `London gold spot price Kitco Investing.com ${year}`, dataType: 'xauusd_alt' },
      { query: `COMEX gold futures close price today`, dataType: 'xauusd_alt2' },
      { query: `上海金 Au99.99 今日行情 ${year}`, dataType: 'shanghai_gold' },
      { query: `上海黄金交易所 Au99.99 收盘价`, dataType: 'shanghai_gold_alt' },
      { query: `黄金ETF 518880 最新净值 涨跌幅`, dataType: 'etf_nav' },
      { query: `US dollar index DXY today`, dataType: 'dxy' },
      { query: `US 10 year treasury yield TIPS real yield today`, dataType: 'us10y' },
    ];

    const searchResults = await this.searchRouter.searchBatch(searches, { numResults: 3 });
    const data = await this.extractMarketDataFromSearch(searchResults);
    try {
      this.saveSnapshot(data);
    } catch (err) {
      console.error('保存快照失败:', err);
    }
    return data;
  }

  /**
   * 回填过去 days 天缺失的 london_close（需 TAVILY + LLM）。
   * 仅写入缺失日，不覆盖已有数据。
   */
  async backfillHistory(days = 60): Promise<{ filled: number; attempted: number }> {
    if (!this.searchRouter.enabled) {
      throw new Error('未配置 TAVILY_API_KEY，无法回填历史金价。');
    }

    const db = getDb();
    const repo = new GoldPricesRepo(db);
    const missing = listMissingLondonDates(repo, days);
    if (missing.length === 0) {
      return { filled: 0, attempted: 0 };
    }

    const from = missing[0];
    const to = missing[missing.length - 1];
    const year = new Date().getFullYear();

    const searches = [
      { query: `XAUUSD gold daily closing price history ${from} to ${to} ${year}`, dataType: 'hist' },
      { query: `London gold historical daily close price chart ${days} days`, dataType: 'hist2' },
    ];
    const searchResults = await this.searchRouter.searchBatch(searches, { numResults: 5 });
    const totalResults = Array.from(searchResults.values()).reduce((n, arr) => n + arr.length, 0);
    if (totalResults === 0) {
      throw new Error('历史金价搜索无结果，无法回填。');
    }

    const context = formatSearchContext(searchResults);
    const schema = {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              londonClose: { type: 'number' },
              shanghaiClose: { type: 'number' },
            },
            required: ['date', 'londonClose'],
          },
        },
      },
      required: ['rows'],
    };

    const extracted = await this.structuredPrompt<{ rows: HistoryPriceRow[] }>(
      `请从搜索结果中提取伦敦金（XAUUSD）每日收盘价。\n`
      + `仅输出以下缺失日期（YYYY-MM-DD）中有据可查的行，严禁编造：\n${missing.join(', ')}\n\n`
      + `${context}`,
      schema,
    );

    const allowed = new Set(missing);
    const rows = normalizeHistoryRows(extracted.rows ?? [], allowed);
    let filled = 0;
    for (const row of rows) {
      repo.upsert({
        date: row.date,
        londonClose: row.londonClose,
        londonHigh: null,
        londonLow: null,
        shanghaiClose: row.shanghaiClose ?? null,
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

    return { filled, attempted: missing.length };
  }

  /** 采集并持久化跟踪基金净值（供 fund 命令） */
  async collectFundNavs(): Promise<void> {
    if (!this.searchRouter.enabled) {
      throw new Error('未配置 TAVILY_API_KEY，无法采集基金净值。');
    }

    const searches = TRACKED_FUNDS.map(f => ({
      query: `${f.name} ${f.code} 最新净值 涨跌幅`,
      dataType: `fund_${f.code}`,
    }));
    const searchResults = await this.searchRouter.searchBatch(searches, { numResults: 3 });
    const context = formatSearchContext(searchResults);

    const schema = {
      type: 'object',
      properties: {
        funds: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              name: { type: 'string' },
              nav: { type: 'number' },
              changePct: { type: 'number' },
              premium: { type: 'number' },
            },
            required: ['code', 'nav'],
          },
        },
      },
      required: ['funds'],
    };

    const extracted = await this.structuredPrompt<{
      funds: Array<{ code: string; name?: string; nav: number; changePct?: number; premium?: number }>;
    }>(
      `当前时间: ${formatNow()}\n从搜索结果提取以下基金的最新净值（严禁捏造）：\n`
      + `${TRACKED_FUNDS.map(f => f.code).join(', ')}\n\n${context}`,
      schema,
    );

    const date = todayDate();
    const db = getDb();
    const repo = new FundNavRepo(db);
    for (const f of extracted.funds ?? []) {
      if (!f.code || f.nav == null || !Number.isFinite(f.nav)) continue;
      repo.upsert({
        date,
        code: f.code,
        nav: f.nav,
        accNav: f.nav,
        changePct: f.changePct ?? 0,
        premium: f.premium ?? null,
      });
    }
  }

  private async extractMarketDataFromSearch(
    searchResults: Map<string, SearchResult[]>,
  ): Promise<MarketData> {
    const totalResults = Array.from(searchResults.values()).reduce((n, arr) => n + arr.length, 0);
    if (totalResults === 0) {
      throw new Error('搜索结果为空，无法采集市场数据。请配置 TAVILY_API_KEY 并确认网络连接；为避免编造数据，已中止本次采集。');
    }

    const searchContext = formatSearchContext(searchResults);
    const data = await this.structuredPrompt<MarketData>(
      `当前时间: ${formatNow()}\n\n请从以下搜索结果中提取金价数据:\n\n${searchContext}`,
      MARKET_DATA_SCHEMA,
    );
    return data;
  }

  /** 保存金价快照 + ETF 净值 */
  private saveSnapshot(data: MarketData): void {
    const db = getDb();
    const date = todayDate();
    const repo = new GoldPricesRepo(db);

    repo.upsert({
      date,
      londonClose: data.london?.price?.value ?? null,
      londonHigh: data.london?.high?.value ?? null,
      londonLow: data.london?.low?.value ?? null,
      shanghaiClose: data.shanghai?.price?.value ?? null,
      shanghaiHigh: data.shanghai?.high?.value ?? null,
      shanghaiLow: data.shanghai?.low?.value ?? null,
      etfNav: data.etf?.nav?.value ?? null,
      etfChange: data.etf?.nav?.change ?? null,
      dollarIndex: data.dollarIndex?.value?.value ?? null,
      us10yYield: data.usTreasury?.yield10y?.value ?? null,
      tipsYield: data.usTreasury?.tips?.value ?? null,
    });

    if (data.etf?.nav?.value != null) {
      const fundRepo = new FundNavRepo(db);
      fundRepo.upsert({
        date,
        code: data.etf.code ?? '518880',
        nav: data.etf.nav.value,
        accNav: data.etf.nav.value,
        changePct: data.etf.nav.change ?? 0,
        premium: data.etf.premiumDiscount?.value ?? null,
      });
    }
  }
}

function formatSearchContext(searchResults: Map<string, SearchResult[]>): string {
  const MAX_SNIPPET = 300;
  return Array.from(searchResults.entries())
    .map(([query, results]) => {
      const snippets = results
        .map(r => {
          const snip = r.snippet.length > MAX_SNIPPET ? r.snippet.slice(0, MAX_SNIPPET) + '...' : r.snippet;
          return `[${r.engine}] ${r.title}: ${snip}`;
        })
        .join('\n');
      return `搜索 "${query}" 结果:\n${snippets}`;
    })
    .join('\n\n');
}
