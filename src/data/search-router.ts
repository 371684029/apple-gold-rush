// 搜索路由器 — 基于 Tavily 的金融数据搜索 + 来源分级
//
// 当前实现使用单一搜索引擎 Tavily（@tavily/core）。未配置 TAVILY_API_KEY 时
// 自动降级为空结果（不抛错），让仅依赖本地 SQLite 的命令（history/calibrate 等）
// 仍可正常运行。

import { tavily, type TavilyClient } from '@tavily/core';
import { gradeSource } from '../utils/source-rank.js';
import type { SearchResult, SearchOptions } from '../types/market.js';

/** searchBatch 单条查询定义 */
export interface BatchSearchItem {
  query: string;
  dataType?: string;
}

/** searchBatch 选项 */
export interface BatchSearchOptions {
  numResults?: number;
}

export class SearchRouter {
  private client: TavilyClient | null;
  private warnedNoKey = false;

  constructor(tavilyApiKey: string) {
    this.client = tavilyApiKey ? tavily({ apiKey: tavilyApiKey }) : null;
  }

  /** 是否已配置可用的搜索引擎 */
  get enabled(): boolean {
    return this.client !== null;
  }

  /** 单条搜索 */
  async search(query: string, options: Partial<SearchOptions> = {}): Promise<SearchResult[]> {
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

      return res.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        engine: 'tavily' as const,
        publishedDate: r.publishedDate,
        sourceGrade: gradeSource(hostnameOf(r.url)),
      }));
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
