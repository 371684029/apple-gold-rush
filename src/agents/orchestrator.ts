// 综合编排 Agent — 汇总四维度 + 反驳 + 校准 + 双轨策略

import { BaseAgent } from './base.js';
import { getConfig } from '../utils/config.js';
import { getDb } from '../db/index.js';
import { CalibrationRepo } from '../db/calibration.js';
import { ScenarioFeaturesRepo } from '../db/scenario-features.js';
import { ReportsRepo } from '../db/reports.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import { forwardFillCloses, latestDeviationFromMA } from '../utils/price-series.js';
import type { TechnicalAnalysis, FundamentalAnalysis, SentimentAnalysis, Direction, ShortTermStrategy, MidTermStrategy, Scenarios, RebuttalAnalysis, GoldAnalysisReport } from '../types/analysis.js';
import type { MarketData } from '../types/market.js';
import type { FundAnalysis } from '../types/fund.js';

const ORCHESTRATOR_PROMPT = `你是黄金投资研究综合编排师。你将汇总技术面、基本面、情绪面、基金面四维度分析，结合反驳分析和校准数据，输出双视角策略报告。

## 双视角分析规则

### 短期视角（日线级别，持仓数天~2周）
- 操作品种：黄金ETF场内(518880)、纸黄金
- 入场信号：日线MACD金叉、RSI超卖回升等
- 出场策略：目标位止盈 + 固定止损(3-5%)
- 快进快出，不恋战

### 中长期视角（周线级别，持仓1~6个月）
- 第一层：定投基础仓（60-70%）— 积存金或000216/002610定投
- 第二层：波段加减仓（30-40%）— 金价处于周线支撑区加仓，阻力区减仓
- 风控：估值止盈（偏离年线>15%考虑减仓）

## 情景分析要求

你必须输出三个情景（基准/上行/下行），而非单一预测：
1. 基准情景：最可能发生的路径（概率45-60%）
2. 上行情景：超预期情景（概率15-30%）
3. 下行情景：不及预期情景（概率15-30%，不得低于15%）

规则：
- 三个概率之和 = 100%
- 每个情景必须有明确的触发条件
- 下行情景的概率不得低于15%（这是风险暴露的要求）

## 投资风格规则
1. 严禁推荐杠杆/期货产品
2. 具体说明持有期适合A类还是C类基金
3. 短期和中长期信号矛盾时，必须同时呈现两方逻辑

  ## 反驳结果处理
  1. 如果反驳强度≥中等，在风险提示中突出看空论据
  2. 不得忽略反驳结果
  3. 评分应考虑反驳修正

## 输出格式（严格遵守，直接输出JSON，不要用markdown代码块）
{
  "overall": {
    "score": 数字(0-100),
    "direction": "bullish/bearish/neutral",
    "scenarios": {
      "base": { "probability": 数字, "description": "字符串", "goldPrice": "字符串", "action": "字符串", "confidence": "low/moderate/high" },
      "upside": { "probability": 数字, "description": "字符串", "goldPrice": "字符串", "trigger": "字符串", "action": "字符串", "confidence": "low/moderate/high" },
      "downside": { "probability": 数字, "description": "字符串", "goldPrice": "字符串", "trigger": "字符串", "action": "字符串", "confidence": "low/moderate/high" }
    },
    "shortTerm": {
      "horizon": "short-term",
      "action": "字符串",
      "entryZone": "字符串",
      "target": "字符串",
      "stopLoss": "字符串",
      "recommendedProduct": "字符串",
      "riskWarning": "字符串"
    },
    "midTerm": {
      "horizon": "medium-term",
      "investAdvice": { "dipInvest": "continue/increase/pause", "positionAdjust": "add/reduce/hold", "recommendedFund": "字符串" },
      "keyLevels": { "supportZone": "字符串", "resistanceZone": "字符串" },
      "riskWarning": "字符串"
    }
  }
}`;

export class OrchestratorAgent extends BaseAgent {
  constructor() {
    const config = getConfig();
    super({ name: 'orchestrator', model: config.models.orchestrator, systemPrompt: ORCHESTRATOR_PROMPT });
  }

  /** 综合编排，输出完整报告 */
  async orchestrate(
    marketData: MarketData,
    technical: TechnicalAnalysis,
    fundamental: FundamentalAnalysis,
    sentiment: SentimentAnalysis,
    fund: FundAnalysis,
    rebuttal: RebuttalAnalysis,
    horizon: 'short' | 'mid' | 'all' = 'all',
  ): Promise<GoldAnalysisReport> {
    // 获取校准上下文
    const db = getDb();
    const calibrationRepo = new CalibrationRepo(db);
    const initialScore = rebuttal.adjustedScore ?? Math.round((technical.score + fundamental.score + sentiment.score) / 3);
    const calibrationContext = calibrationRepo.getCalibrationContext(initialScore);

    // 自动回填
    try {
      calibrationRepo.backfillPending();
    } catch { /* ignore */ }

    // 注入校准数据
    let calibrationText = '校准数据不足（样本<5），暂无统计参考';
    if (calibrationContext && calibrationContext.historicalAccuracy !== null) {
      calibrationText = `评分${calibrationContext.scoreRange}区间：历史${calibrationContext.sampleSize}次分析，实际涨概率${Math.round(calibrationContext.historicalAccuracy * 100)}%，系统偏差：${calibrationContext.systematicBias}`;
    }

    const schema = {
      type: 'object',
      properties: {
        overall: {
          type: 'object',
          properties: {
            score: { type: 'number' },
            direction: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
            scenarios: {
              type: 'object',
              properties: {
                base: { type: 'object', properties: { probability: { type: 'number' }, description: { type: 'string' }, goldPrice: { type: 'string' }, action: { type: 'string' }, confidence: { type: 'string' } } },
                upside: { type: 'object', properties: { probability: { type: 'number' }, description: { type: 'string' }, goldPrice: { type: 'string' }, trigger: { type: 'string' }, action: { type: 'string' }, confidence: { type: 'string' } } },
                downside: { type: 'object', properties: { probability: { type: 'number' }, description: { type: 'string' }, goldPrice: { type: 'string' }, trigger: { type: 'string' }, action: { type: 'string' }, confidence: { type: 'string' } } },
              },
            },
            shortTerm: {
              type: 'object',
              properties: {
                horizon: { type: 'string' },
                action: { type: 'string' },
                entryZone: { type: 'string' },
                target: { type: 'string' },
                stopLoss: { type: 'string' },
                recommendedProduct: { type: 'string' },
                riskWarning: { type: 'string' },
              },
            },
            midTerm: {
              type: 'object',
              properties: {
                horizon: { type: 'string' },
                investAdvice: { type: 'object', properties: { dipInvest: { type: 'string' }, positionAdjust: { type: 'string' }, recommendedFund: { type: 'string' } } },
                keyLevels: { type: 'object', properties: { supportZone: { type: 'string' }, resistanceZone: { type: 'string' } } },
                riskWarning: { type: 'string' },
              },
            },
          },
        },
      },
      required: ['overall'],
    };

    const fmtPct = (v: number | null | undefined): string => (v == null ? 'N/A' : `${v > 0 ? '+' : ''}${v}%`);
    const safe = (v: unknown, fallback = 'N/A'): string => v == null ? fallback : String(v);
    const londonVal = marketData.london?.price?.value;
    const londonChg = marketData.london?.price?.change;
    const shanghaiVal = marketData.shanghai?.price?.value;
    const etfNavVal = marketData.etf?.nav?.value;
    const dxyVal = marketData.dollarIndex?.value?.value;

    const prompt = `## 市场数据
伦敦金: $${safe(londonVal)} (${londonChg != null ? (londonChg > 0 ? '+' : '') + londonChg + '%' : 'N/A'})
上海金: ¥${safe(shanghaiVal)}/g
ETF(518880): ${safe(etfNavVal)}
美元指数: ${safe(dxyVal)}
10Y美债: ${marketData.usTreasury?.yield10y?.value ?? 'N/A'}%

## 技术面 (${technical.score}/100 ${technical.direction})
短期: ${technical.shortTerm.trend}, ${technical.shortTerm.keySignal}
中长期: ${technical.midTerm.trend}, ${technical.midTerm.keySignal}

## 基本面 (${fundamental.score}/100 ${fundamental.direction})
${fundamental.keyPoints.join('; ')}

## 情绪面 (${sentiment.score}/100 ${sentiment.direction})
${sentiment.keyPoints.join('; ')}

## 基金面
估值: ${fund.valuation?.level ?? 'N/A'}, 溢价折价: ${fund.premiumDiscount?.current ?? 'N/A'}%

## 反驳分析
看空力度: ${rebuttal.bearScore}/100 (强度: ${rebuttal.rebuttalStrength})
看空论据: ${(rebuttal.bearPoints ?? []).map(p => p.point).join('; ')}
看多漏洞: ${(rebuttal.bullVulnerabilities ?? []).map(v => v.vulnerability).join('; ')}
评分修正: ${rebuttal.adjustedScore ?? '未修正'} (${rebuttal.netEffect})

## 历史校准
${calibrationText}

## 输出视角
${horizon === 'short' ? '仅短期视角' : horizon === 'mid' ? '仅中长期视角' : '双视角（短期+中长期）'}

## 评分规则（重要）
你的综合评分(overall.score)必须以修正后的评分为准。本报告的修正评分为 ${initialScore}。
你的任务不是重新打分，而是基于 ${initialScore} 分撰写配套的综合研判、情景分析和双轨策略。
评分只能在小范围内微调（±3分），且必须在报告中说明调整理由。`;

    const result = await this.structuredPrompt<{
      overall: {
        score: number;
        direction: Direction;
        scenarios: Scenarios;
        shortTerm: ShortTermStrategy;
        midTerm: MidTermStrategy;
      };
    }>(prompt, schema);

    // 构建完整报告
    const report: GoldAnalysisReport = {
      timestamp: new Date().toISOString(),
      marketData,
      dataQuality: {
        overallConfidence: 80,
        warnings: [],
      },
      technical,
      fundamental,
      sentiment,
      fund,
      rebuttal,
      tailRisks: rebuttal.tailRisks ?? [],
      overall: {
        ...result.overall,
        // 强制评分一致性：最终评分必须等于反驳修正后的评分
        score: initialScore,
        calibration: calibrationContext ?? {
          scoreRange: 'N/A',
          historicalAccuracy: null,
          systematicBias: '样本不足',
          sampleSize: 0,
        },
      },
    };

    // 自动保存报告到 SQLite
    this.saveReport(report, horizon);

    return report;
  }

  /** 保存报告 */
  private saveReport(report: GoldAnalysisReport, horizon: string): void {
    try {
      const db = getDb();
      const reportsRepo = new ReportsRepo(db);
      const reportId = reportsRepo.insert({
        date: report.timestamp.slice(0, 10),
        horizon,
        reportJson: JSON.stringify(report),
        overallScore: report.overall.score,
        direction: report.overall.direction,
      });

      // 存储市场特征向量（从实际分析结果提取）
      const featuresRepo = new ScenarioFeaturesRepo(db);
      const d = report.marketData?.dollarIndex?.value?.change ?? 0;
      const m = report.marketData;
      const t = report.technical;
      const f = report.fundamental;
      const s = report.sentiment;

      // TIPS 变动方向
      const tipsChange = m?.usTreasury?.tips?.value;
      const tipsDir = tipsChange != null ? (tipsChange > 0 ? 'up' : tipsChange < 0 ? 'down' : 'flat') : 'flat';

      // VIX 等级估算
      const vixText = s?.vix ?? '';
      let vixLevel = 15;
      if (vixText) {
        const vixMatch = vixText.match(/(\d+\.?\d*)/);
        if (vixMatch) vixLevel = parseFloat(vixMatch[1]);
      }

      // 金价偏离 MA20（本地计算）
      let goldDeviation = 0;
      try {
        const pricesRepo = new GoldPricesRepo(db);
        const closes = forwardFillCloses(pricesRepo.getRecent(60));
        const dev = latestDeviationFromMA(closes, 20);
        if (dev != null) goldDeviation = dev;
      } catch { /* ignore */ }

      // fedStance 从基本面提取
      const fedRaw = f?.fedStance ?? '';

      featuresRepo.insert({
        date: report.timestamp.slice(0, 10),
        reportId,
        dollarDirection: d > 0.5 ? 'up' : d < -0.5 ? 'down' : 'flat',
        dollarMagnitude: Math.abs(d),
        tipsDirection: tipsDir,
        tipsMagnitude: tipsChange != null ? Math.abs(tipsChange) : 0,
        goldDeviation: 0,
        vixLevel,
        fedStance: fedRaw.includes('鸽') ? 'dovish' : fedRaw.includes('鹰') ? 'hawkish' : 'neutral',
        geopoliticalRisk: s?.geopoliticalRisk?.includes('高') ? 'high' : s?.geopoliticalRisk?.includes('低') ? 'low' : 'medium',
        momentumDirection: report.overall.direction === 'bullish' ? 'up' : report.overall.direction === 'bearish' ? 'down' : 'flat',
        consecutiveDays: 0,
      });
    } catch (err) {
      console.error('保存报告失败:', err);
    }
  }
}
