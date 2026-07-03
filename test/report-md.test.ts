import { describe, it, expect } from 'vitest';
import { formatReportMarkdown } from '../src/utils/report-md';
import type { GoldAnalysisReport } from '../src/types/analysis';

function buildReport(): GoldAnalysisReport {
  return {
    timestamp: '2026-06-24T00:00:00.000Z',
    marketData: {
      timestamp: '2026-06-24T00:00:00.000Z',
      london: { price: { value: 2350, change: 0.8, source: 'Kitco', sourceGrade: 'B', verifiedAt: '' } },
      shanghai: { price: { value: 545, change: 0.5, source: '上海黄金交易所', sourceGrade: 'A', verifiedAt: '' } },
      etf: { code: '518880', name: '华安黄金ETF', nav: { value: 5.2, change: 0.6, source: 'x', sourceGrade: 'B', verifiedAt: '' } },
      dollarIndex: { value: { value: 104, change: -0.2, source: 'x', sourceGrade: 'B', verifiedAt: '' } },
      usTreasury: { yield10y: { value: 4.2, change: 0, source: 'x', sourceGrade: 'B', verifiedAt: '' }, tips: { value: 1.9, source: 'x', sourceGrade: 'B', verifiedAt: '' } },
    },
    dataQuality: { overallConfidence: 82, warnings: [] },
    technical: { score: 70, direction: 'bullish', keyPoints: [], counterPoints: [], summary: '均线多头', sources: [], shortTerm: { timeframe: 'daily', support: 2300, resistance: 2400, trend: '上行', indicators: { ma5: '', ma20: '', macd: '', rsi: '' }, keySignal: '金叉' }, midTerm: { timeframe: 'weekly', support: 2200, resistance: 2500, trend: '上行', indicators: { ma20w: '', ma60w: '', macd: '', rsi: '' }, keySignal: '多头' } },
    fundamental: { score: 65, direction: 'bullish', keyPoints: [], counterPoints: [], summary: '实际利率回落', sources: [], dollarIndexEffect: '', interestRateEffect: '', inflationEffect: '', fedStance: 'neutral' },
    sentiment: { score: 60, direction: 'neutral', keyPoints: [], counterPoints: [], summary: '央行持续购金', sources: [], centralBanks: '', cftcPosition: '', vix: '', geopoliticalRisk: '', etfFlows: '' },
    fund: { recommendation: { longTerm: '000216', mediumTerm: '000217', dipBuy: '积存金' }, valuation: { level: 'fair', indicator: '', action: '维持定投' }, premiumDiscount: { current: 0.3, trend: '', advice: '' } },
    rebuttal: {
      bullScore: 40, bearScore: 60, rebuttalStrength: 'moderate',
      bearPoints: [{ point: '美元反弹', evidence: '', probability: 35, impact: '' }],
      bullVulnerabilities: [{ originalPoint: '', vulnerability: '购金需求不可持续', counterCondition: '' }],
      netEffect: 'downgraded', adjustedScore: 64, tailRisks: [],
    },
    tailRisks: [{ risk: '美联储超预期鹰派', probability: 15, impact: '金价快速回调', trigger: 'CPI 超预期', mitigation: '降低仓位' }],
    overall: {
      score: 64, direction: 'bullish',
      scenarios: {
        base: { probability: 55, description: '震荡上行', goldPrice: '2300-2400', action: '维持定投', confidence: 'moderate' },
        upside: { probability: 25, description: '突破新高', goldPrice: '>2450', action: '加仓', confidence: 'low', trigger: '降息预期升温' },
        downside: { probability: 20, description: '回调', goldPrice: '<2250', action: '暂停定投', confidence: 'low', trigger: '美元走强' },
      },
      calibration: { scoreRange: '60-70', historicalAccuracy: 0.58, systematicBias: '偏乐观', sampleSize: 12 },
      shortTerm: { horizon: 'short-term', action: '逢低参与', entryZone: '2300-2320', target: '2400', stopLoss: '2270', recommendedProduct: '518880', riskWarning: '注意美元' },
      midTerm: { horizon: 'medium-term', investAdvice: { dipInvest: 'continue', positionAdjust: 'hold', recommendedFund: '000216' }, keyLevels: { supportZone: '2200-2250', resistanceZone: '2450-2500' }, riskWarning: '估值偏高需控仓' },
    },
  };
}

describe('formatReportMarkdown', () => {
  it('生成包含关键小节的 Markdown 日报', () => {
    const md = formatReportMarkdown(buildReport(), 'all');
    expect(md).toContain('# 🥇 GoldRush 黄金投资日报');
    expect(md).toContain('## 综合研判');
    expect(md).toContain('## 📊 评分构成');
    expect(md).toContain('64/100');
    expect(md).toContain('## ⚡ 情景分析');
    expect(md).toContain('## 📈 四维度摘要');
    expect(md).toContain('## 🔴 强制反驳');
    expect(md).toContain('## ⏱️ 短期策略');
    expect(md).toContain('## 📅 中长期策略');
    expect(md).toContain('## ⚠️ 尾部风险');
    expect(md).toContain('不构成投资建议');
  });

  it('horizon=short 时不输出中长期策略', () => {
    const md = formatReportMarkdown(buildReport(), 'short');
    expect(md).toContain('## ⏱️ 短期策略');
    expect(md).not.toContain('## 📅 中长期策略');
  });

  it('字段缺失时降级为 N/A 而不抛错', () => {
    const partial = { timestamp: '2026-06-24T00:00:00.000Z' } as unknown as GoldAnalysisReport;
    const md = formatReportMarkdown(partial, 'all');
    expect(md).toContain('N/A');
    expect(md).toContain('不构成投资建议');
  });
});
