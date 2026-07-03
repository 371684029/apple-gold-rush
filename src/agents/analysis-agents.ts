// 四维度分析 Agent

import { BaseAgent } from './base.js';
import { getConfig } from '../utils/config.js';
import { getDb } from '../db/index.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import { latestMA, latestRSI, rsiSignal, latestMACD, macdCross, latestBollinger, deviationFromMA } from '../indicators/index.js';
import type { TechnicalAnalysis, FundamentalAnalysis, SentimentAnalysis } from '../types/analysis.js';
import type { MarketData, GoldPriceRecord } from '../types/market.js';
import type { FundAnalysis } from '../types/fund.js';
import { forwardFillCloses } from '../utils/price-series.js';

/**
 * 将日线数据聚合为周线 OHLC。
 * 周以 ISO 周一为界，返回每周的 [开盘, 最高, 最低, 收盘(周五)];
 * 只有 >= 3 天数据的周才计入，避免周末异常。
 */
function aggregateWeekly(records: GoldPriceRecord[]): Array<{ weekStart: string; close: number }> {
  const weekMap = new Map<string, { opens: number[]; highs: number[]; lows: number[]; closes: number[] }>();

  for (const r of records) {
    if (r.londonClose == null) continue;
    // 计算 ISO 周一日期
    const d = new Date(r.date + 'T00:00:00');
    const day = d.getDay();
    const monOffset = day === 0 ? -6 : 1 - day; // 周日=0 → 前推6天到周一
    const mon = new Date(d);
    mon.setDate(d.getDate() + monOffset);
    const weekKey = mon.toISOString().slice(0, 10);

    if (!weekMap.has(weekKey)) weekMap.set(weekKey, { opens: [], highs: [], lows: [], closes: [] });
    const w = weekMap.get(weekKey)!;
    w.opens.push(r.londonClose);
    if (r.londonHigh != null) w.highs.push(r.londonHigh);
    if (r.londonLow != null) w.lows.push(r.londonLow);
    w.closes.push(r.londonClose);
  }

  const result: Array<{ weekStart: string; close: number }> = [];
  for (const [weekStart, w] of weekMap) {
    if (w.closes.length < 3) continue; // 跳过数据不足的周
    result.push({ weekStart, close: w.closes[w.closes.length - 1] });
  }
  return result.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/** 安全读取 MarketData 嵌套字段 */
function safeVal<T>(fn: () => T, fallback: T): T {
  try { const v = fn(); return v ?? fallback; } catch { return fallback; }
}
function safeStr(fn: () => number | null | undefined, suffix = '', prefix = ''): string {
  try { const v = fn(); return v != null ? `${prefix}${v}${suffix}` : 'N/A'; } catch { return 'N/A'; }
}

// === 技术面 Agent ===
const TECHNICAL_PROMPT = `你是黄金技术面分析专家，同时提供短期（日线）和中长期（周线）两个视角的分析。

## 双视角分析规则

### 短期视角（日线级别，持仓数天~2周）
- 分析周期：日K线、小时线
- 技术指标：5日/20日均线、日线MACD、日线RSI
- 操作建议：精确入场区间、止盈目标、止损位
- 推荐品种：黄金ETF场内(518880)、纸黄金
- 风控方式：固定止损（3-5%）

### 中长期视角（周线级别，持仓1~6个月）
- 分析周期：周K线、月K线
- 技术指标：20周/60周均线、周线MACD、周线RSI
- 操作建议：定投节奏调整、波段加减仓
- 推荐品种：黄金ETF联接A(000216)长期、C(000217)波段、积存金定投
- 风控方式：估值水位判断、仓位管理

## 信息可靠性规则
1. 严禁捏造数据
2. 优先使用注入的本地计算指标（这些是客观计算结果，非LLM推断）
3. 搜索解读仅作为辅助参考
4. 每个结论必须有依据
5. 必须包含至少1条反面论据

## 输出格式
{
  "score": 0-100,
  "direction": "bullish/bearish/neutral",
  "keyPoints": ["论点1", "论点2", "论点3"],
  "counterPoints": ["反方论据"],
  "summary": "一句话总结",
  "sources": ["来源1", "来源2"],
  "shortTerm": {
    "timeframe": "daily",
    "support": 数字,
    "resistance": 数字,
    "trend": "趋势描述",
    "indicators": { "ma5": "状态", "ma20": "状态", "macd": "状态", "rsi": "状态" },
    "keySignal": "关键信号"
  },
  "midTerm": {
    "timeframe": "weekly",
    "support": 数字,
    "resistance": 数字,
    "trend": "趋势描述",
    "indicators": { "ma20w": "状态", "ma60w": "状态", "macd": "状态", "rsi": "状态" },
    "keySignal": "关键信号"
  }
}`;

export class TechnicalAgent extends BaseAgent {
  constructor() {
    const config = getConfig();
    super({ name: 'technical', model: config.models.technical, systemPrompt: TECHNICAL_PROMPT });
  }

  async analyze(data: MarketData): Promise<TechnicalAnalysis> {
    const londonPrice = safeVal(() => data.london.price.value, 0);
    const dollarIdx = safeVal(() => data.dollarIndex.value.value, 0);
    const dollarChange = safeVal(() => data.dollarIndex.value.change, 0);

    // 从 SQLite 加载历史数据，计算本地技术指标
    const db = getDb();
    const repo = new GoldPricesRepo(db);
    const history = repo.getRecent(60);

    let indicatorContext = '';
    if (history.length >= 20) {
      const closes = forwardFillCloses(history);

      if (closes.length >= 20) {
        const ma5 = latestMA(closes, 5);
        const ma20 = latestMA(closes, 20);
        const ma60 = closes.length >= 60 ? latestMA(closes, 60) : null;
        const rsiVal = latestRSI(closes, 14);
        const macdVal = latestMACD(closes);
        const macdCrossVal = macdCross(closes);
        const bb = latestBollinger(closes);
        const dev = deviationFromMA(closes, 20);
        const latestDev = dev.filter((v): v is number => v !== null).pop() ?? null;

        // —— 周线级别指标（从日线聚合计算） ——
        let weeklyContext = '';
        const weeklyCandles = aggregateWeekly(history);
        const weeklyCloses = weeklyCandles.map(c => c.close);
        if (weeklyCloses.length >= 4) {
          const wMa20 = latestMA(weeklyCloses, Math.min(20, weeklyCloses.length));
          const wMa60 = latestMA(weeklyCloses, Math.min(60, weeklyCloses.length));
          const wRsi = latestRSI(weeklyCloses, 14);
          const wMacd = latestMACD(weeklyCloses);
          const wMacdCross = macdCross(weeklyCloses);
          weeklyContext = `
### 周线级别指标（从 ${weeklyCloses.length} 根周线聚合计算）
- 周线数: ${weeklyCloses.length} 根
- MA20W: ${wMa20?.toFixed(2) ?? '数据不足'}
- MA60W: ${wMa60?.toFixed(2) ?? '数据不足'}
- 周RSI(14): ${wRsi?.toFixed(1) ?? '数据不足'} ${wRsi ? rsiSignal(wRsi) : ''}
- 周MACD: ${wMacd ? `MACD=${wMacd.macd?.toFixed(2)}, Signal=${wMacd.signal?.toFixed(2)}, Histogram=${wMacd.histogram?.toFixed(2)}` : '数据不足'}
- 周MACD交叉: ${wMacdCross === 'golden' ? '金叉✅' : wMacdCross === 'dead' ? '死叉❌' : '无交叉'}
`;
        } else {
          weeklyContext = `\n### 周线级别指标：周线数据不足（需至少4根周线，当前${weeklyCloses.length}根）`;
        }

        indicatorContext = `
## 本地计算的技术指标（客观结果，可直接采信）

### 日线级别指标
- 当前价: $${londonPrice.toFixed(2)}
- MA5: ${ma5?.toFixed(2) ?? '数据不足'}
- MA20: ${ma20?.toFixed(2) ?? '数据不足'}
- MA60: ${ma60?.toFixed(2) ?? '数据不足'}
- RSI(14): ${rsiVal?.toFixed(1) ?? '数据不足'} ${rsiVal ? rsiSignal(rsiVal) : ''}
- MACD: ${macdVal ? `MACD=${macdVal.macd?.toFixed(2)}, Signal=${macdVal.signal?.toFixed(2)}, Histogram=${macdVal.histogram?.toFixed(2)}` : '数据不足'}
- MACD交叉: ${macdCrossVal === 'golden' ? '金叉✅' : macdCrossVal === 'dead' ? '死叉❌' : '无交叉'}
- 布林带: ${bb ? `上轨=${bb.upper?.toFixed(2)}, 中轨=${bb.middle?.toFixed(2)}, 下轨=${bb.lower?.toFixed(2)}, %B=${bb.percentB?.toFixed(2)}` : '数据不足'}
- 偏离MA20: ${latestDev?.toFixed(2) ?? '数据不足'}%
- 历史数据天数: ${history.length}天
${weeklyContext}`;
      }
    } else {
      indicatorContext = '## 本地技术指标：历史数据不足（需20天以上），无法计算';
    }

    const schema = {
      type: 'object',
      properties: {
        score: { type: 'number' },
        direction: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
        keyPoints: { type: 'array', items: { type: 'string' } },
        counterPoints: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
        sources: { type: 'array', items: { type: 'string' } },
        shortTerm: {
          type: 'object',
          properties: {
            timeframe: { type: 'string' },
            support: { type: 'number' },
            resistance: { type: 'number' },
            trend: { type: 'string' },
            indicators: { type: 'object', properties: { ma5: { type: 'string' }, ma20: { type: 'string' }, macd: { type: 'string' }, rsi: { type: 'string' } } },
            keySignal: { type: 'string' },
          },
        },
        midTerm: {
          type: 'object',
          properties: {
            timeframe: { type: 'string' },
            support: { type: 'number' },
            resistance: { type: 'number' },
            trend: { type: 'string' },
            indicators: { type: 'object', properties: { ma20w: { type: 'string' }, ma60w: { type: 'string' }, macd: { type: 'string' }, rsi: { type: 'string' } } },
            keySignal: { type: 'string' },
          },
        },
      },
      required: ['score', 'direction', 'keyPoints', 'counterPoints', 'summary', 'sources', 'shortTerm', 'midTerm'],
    };

    const techPromptData = `## 市场数据\n美元指数: ${dollarIdx} (${dollarChange > 0 ? '+' : ''}${dollarChange}%)\n10Y美债: ${safeStr(() => data.usTreasury.yield10y.value, '%')}\nTIPS: ${safeStr(() => data.usTreasury.tips?.value, '%')}\n\n请进行技术面双视角分析。`;

    return this.structuredPrompt<TechnicalAnalysis>(
      `${indicatorContext}\n\n${techPromptData}`,
      schema,
    );
  }
}

// === 基本面 Agent ===
const FUNDAMENTAL_PROMPT = `你是黄金基本面分析专家，从宏观经济角度分析黄金走势。

## 分析维度
- 美元指数影响
- 利率环境影响
- 通胀影响
- 美联储政策倾向

## 信息可靠性规则
1. 严禁捏造数据
2. 因果推理必须标注条件和反例
3. 必须包含至少1条反面论据

## 输出格式
{
  "score": 0-100,
  "direction": "bullish/bearish/neutral",
  "keyPoints": ["论点1", "论点2", "论点3"],
  "counterPoints": ["反方论据"],
  "summary": "一句话总结",
  "sources": ["来源1"],
  "dollarIndexEffect": "美元指数影响描述",
  "interestRateEffect": "利率影响描述",
  "inflationEffect": "通胀影响描述",
  "fedStance": "美联储政策倾向"
}`;

export class FundamentalAgent extends BaseAgent {
  constructor() {
    const config = getConfig();
    super({ name: 'fundamental', model: config.models.fundamental, systemPrompt: FUNDAMENTAL_PROMPT });
  }

  async analyze(data: MarketData): Promise<FundamentalAnalysis> {
    const londonPrice = safeVal(() => data.london.price.value, 0);
    const londonChange = safeVal(() => data.london.price.change, 0);
    const dollarIdx = safeVal(() => data.dollarIndex.value.value, 0);
    const dollarChange = safeVal(() => data.dollarIndex.value.change, 0);

    const schema = {
      type: 'object',
      properties: {
        score: { type: 'number' },
        direction: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
        keyPoints: { type: 'array', items: { type: 'string' } },
        counterPoints: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
        sources: { type: 'array', items: { type: 'string' } },
        dollarIndexEffect: { type: 'string' },
        interestRateEffect: { type: 'string' },
        inflationEffect: { type: 'string' },
        fedStance: { type: 'string' },
      },
      required: ['score', 'direction', 'keyPoints', 'counterPoints', 'summary', 'sources', 'dollarIndexEffect', 'interestRateEffect', 'inflationEffect', 'fedStance'],
    };

    return this.structuredPrompt<FundamentalAnalysis>(
      `## 市场数据\n伦敦金: $${londonPrice} (${londonChange > 0 ? '+' : ''}${londonChange}%)\n美元指数: ${dollarIdx} (${dollarChange > 0 ? '+' : ''}${dollarChange}%)\n10Y美债: ${safeStr(() => data.usTreasury.yield10y.value, '%')}\nTIPS: ${safeStr(() => data.usTreasury.tips?.value, '%')}\n\n请进行基本面分析。`,
      schema,
    );
  }
}

// === 情绪面 Agent ===
const SENTIMENT_PROMPT = `你是黄金情绪面分析专家，从市场情绪和资金流向角度分析。

## 分析维度
- 央行购金动态
- CFTC持仓
- VIX恐慌指数
- 地缘风险
- 黄金ETF资金流入/流出

## 信息可靠性规则
1. 严禁捏造数据
2. 情绪指标需标注方向和强度
3. 必须包含至少1条反面论据

## 输出格式
{
  "score": 0-100,
  "direction": "bullish/bearish/neutral",
  "keyPoints": ["论点1", "论点2", "论点3"],
  "counterPoints": ["反方论据"],
  "summary": "一句话总结",
  "sources": ["来源1"],
  "centralBanks": "央行购金描述",
  "cftcPosition": "CFTC持仓描述",
  "vix": "VIX描述",
  "geopoliticalRisk": "地缘风险描述",
  "etfFlows": "ETF资金流向描述"
}`;

export class SentimentAgent extends BaseAgent {
  constructor() {
    const config = getConfig();
    super({ name: 'sentiment', model: config.models.sentiment, systemPrompt: SENTIMENT_PROMPT });
  }

  async analyze(data: MarketData): Promise<SentimentAnalysis> {
    const londonPrice = safeVal(() => data.london.price.value, 0);
    const etfNav = safeVal(() => data.etf.nav.value, 0);
    const etfChange = safeVal(() => data.etf.nav.change, 0);
    const dollarIdx = safeVal(() => data.dollarIndex.value.value, 0);

    const schema = {
      type: 'object',
      properties: {
        score: { type: 'number' },
        direction: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
        keyPoints: { type: 'array', items: { type: 'string' } },
        counterPoints: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
        sources: { type: 'array', items: { type: 'string' } },
        centralBanks: { type: 'string' },
        cftcPosition: { type: 'string' },
        vix: { type: 'string' },
        geopoliticalRisk: { type: 'string' },
        etfFlows: { type: 'string' },
      },
      required: ['score', 'direction', 'keyPoints', 'counterPoints', 'summary', 'sources', 'centralBanks', 'cftcPosition', 'vix', 'geopoliticalRisk', 'etfFlows'],
    };

    return this.structuredPrompt<SentimentAnalysis>(
      `## 市场数据\n伦敦金: $${londonPrice}\nETF(518880): ${etfNav} (${etfChange > 0 ? '+' : ''}${etfChange}%)\n美元指数: ${dollarIdx}\n\n请进行情绪面分析。`,
      schema,
    );
  }
}

// === 基金面 Agent ===
const FUND_PROMPT = `你是黄金基金分析专家，从基金费率和估值角度分析。

## 分析要点
- A类(000216)适合长期持有(>1年)，有申购费无销售服务费
- C类(000217/002611)适合短期波段(<1年)，无申购费有销售服务费
- 518880是场内ETF，关注溢价/折价
- 严禁推荐杠杆/期货产品

## 输出格式（严格遵守，直接输出JSON）
{
  "valuation": { "level": "low/fair/high", "indicator": "判断依据", "action": "定投/观望/减仓" },
  "premiumDiscount": { "current": 数字, "trend": "趋势", "advice": "建议" },
  "recommendation": { "longTerm": "推荐品种及原因", "mediumTerm": "推荐品种及原因", "dipBuy": "推荐品种及原因" }
}`;

export class FundAgent extends BaseAgent {
  constructor() {
    const config = getConfig();
    super({ name: 'fund', model: config.models.fund, systemPrompt: FUND_PROMPT });
  }

  async analyze(data: MarketData): Promise<FundAnalysis> {
    const etfNav = safeVal(() => data.etf.nav.value, 0);
    const etfChange = safeVal(() => data.etf.nav.change, 0);
    const londonPrice = safeVal(() => data.london.price.value, 0);

    const schema = {
      type: 'object',
      properties: {
        valuation: { type: 'object', properties: { level: { type: 'string' }, indicator: { type: 'string' }, action: { type: 'string' } } },
        premiumDiscount: { type: 'object', properties: { current: { type: 'number' }, trend: { type: 'string' }, advice: { type: 'string' } } },
        recommendation: { type: 'object', properties: { longTerm: { type: 'string' }, mediumTerm: { type: 'string' }, dipBuy: { type: 'string' } } },
      },
      required: ['valuation', 'premiumDiscount', 'recommendation'],
    };

    return this.structuredPrompt<FundAnalysis>(
      `## 市场数据\nETF(518880): ${etfNav} (${etfChange > 0 ? '+' : ''}${etfChange}%)\n伦敦金: $${londonPrice}\n\n请分析黄金基金估值和投资建议。`,
      schema,
    );
  }
}
