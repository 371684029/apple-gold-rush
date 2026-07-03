// 搜索路由器 — Tavily 金融搜索 + SQLite 缓存 + 来源分级

import { tavily, type TavilyClient } from '@tavily/core';
import { gradeSource } from '../utils/source-rank.js';
import type { SearchResult, SearchOptions } from '../types/market.js';
import type { SearchCacheRepo } from '../db/search-cache.js';

/** searchBatch 单条查询定义 */
export interface BatchSearchItem {
  query: string;
  dataType?: string;
}

/** searchBatch 选项 */
export interface BatchSearchOptions {
  numResults?: number;
}

export interface SearchRouterOptions {
  cache?: SearchCacheRepo;
}

export class SearchRouter {
  private client: TavilyClient | null;
  private cache: SearchCacheRepo | null;
  private warnedNoKey = false;

  constructor(tavilyApiKey: string, options: SearchRouterOptions = {}) {
    this.client = tavilyApiKey ? tavily({ apiKey: tavilyApiKey }) : null;
    this.cache = options.cache ?? null;
    if (this.cache) {
      this.cache.purge();
    }
  }

  /** 是否已配置可用的搜索引擎 */
  get enabled(): boolean {
    return this.client !== null;
  }

  /** 单条搜索 */
  async search(query: string, options: Partial<SearchOptions> = {}): Promise<SearchResult[]> {
    const engine = 'tavily';
    const useCache = options.useCache !== false;

    if (useCache && this.cache) {
      const cached = this.cache.get(query, engine);
      if (cached) {
        try {
          return JSON.parse(cached) as SearchResult[];
        } catch {
          /* 缓存损坏，继续远程搜索 */
        }
      }
    }

    if (!this.client) {
      if (!this.warnedNoKey) {
        console.error('⚠️ 未配置 TAVILY_API_KEY，搜索已降级为空结果。请在 .env 中设置 TAVILY_API_KEY 以启用联网数据采集。');
        this.warnedNoKey = true;
      }
      return [];
    }

    try {
      const res = await this.client.search(query, {
        maxResults: options.numResults ?? 5,
        topic: 'finance',
        searchDepth: 'basic',
      });

      const results: SearchResult[] = res.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        engine: 'tavily' as const,
        publishedDate: r.publishedDate,
        sourceGrade: gradeSource(hostnameOf(r.url)),
      }));

      if (useCache && this.cache && results.length > 0) {
        this.cache.set(query, engine, JSON.stringify(results));
      }

      return results;
    } catch (err) {
      console.error(`⚠️ 搜索失败 "${query}": ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** 批量搜索，返回以查询字符串为 key 的结果 Map */
  async searchBatch(
    searches: BatchSearchItem[],
    options: BatchSearchOptions = {},
  ): Promise<Map<string, SearchResult[]>> {
    const numResults = options.numResults ?? 5;
    const entries = await Promise.all(
      searches.map(async (s) => {
        const results = await this.search(s.query, { numResults });
        return [s.query, results] as const;
      }),
    );

    return new Map(entries);
  }
}

/** 从 URL 提取主机名（用于来源分级），解析失败时回退原串 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
