// 从市场数据 + 报告构建 scenario 特征（编排与相似日检索共用）

import type { GoldAnalysisReport, Direction } from '../types/analysis.js';
import type { MarketData } from '../types/market.js';
import type { ScenarioFeature } from '../types/calibration.js';

export interface ScenarioFeatureDraft {
  date: string;
  dollarDirection: 'up' | 'down' | 'flat';
  dollarMagnitude: number;
  tipsDirection: 'up' | 'down' | 'flat';
  tipsMagnitude: number;
  goldDeviation: number;
  vixLevel: number;
  fedStance: 'hawkish' | 'dovish' | 'neutral';
  geopoliticalRisk: 'high' | 'medium' | 'low';
  momentumDirection: 'up' | 'down' | 'flat';
  consecutiveDays: number;
}

export function buildScenarioFeatureDraft(
  report: {
    timestamp: string;
    marketData: MarketData;
    technical: GoldAnalysisReport['technical'];
    fundamental: GoldAnalysisReport['fundamental'];
    sentiment: GoldAnalysisReport['sentiment'];
    overall: { direction: Direction };
  },
  goldDeviation: number,
  consecutiveDays: number,
): ScenarioFeatureDraft {
  const m = report.marketData;
  const d = m?.dollarIndex?.value?.change ?? 0;
  const tipsChange = m?.usTreasury?.tips?.value;
  const tipsDir = tipsChange != null ? (tipsChange > 0 ? 'up' : tipsChange < 0 ? 'down' : 'flat') : 'flat';

  const vixText = report.sentiment?.vix ?? '';
  let vixLevel = 15;
  if (vixText) {
    const m = vixText.match(/(\d+\.?\d*)/);
    if (m) vixLevel = parseFloat(m[1]);
  }

  const fedRaw = report.fundamental?.fedStance ?? '';
  const dir = report.overall.direction;

  return {
    date: report.timestamp.slice(0, 10),
    dollarDirection: d > 0.5 ? 'up' : d < -0.5 ? 'down' : 'flat',
    dollarMagnitude: Math.abs(d),
    tipsDirection: tipsDir,
    tipsMagnitude: tipsChange != null ? Math.abs(tipsChange) : 0,
    goldDeviation,
    vixLevel,
    fedStance: fedRaw.includes('鸽') ? 'dovish' : fedRaw.includes('鹰') ? 'hawkish' : 'neutral',
    geopoliticalRisk: report.sentiment?.geopoliticalRisk?.includes('高')
      ? 'high'
      : report.sentiment?.geopoliticalRisk?.includes('低')
        ? 'low'
        : 'medium',
    momentumDirection: dir === 'bullish' ? 'up' : dir === 'bearish' ? 'down' : 'flat',
    consecutiveDays,
  };
}

/** 草稿转相似日检索用的 ScenarioFeature（无 id） */
export function draftToScenarioFeature(draft: ScenarioFeatureDraft): ScenarioFeature {
  return {
    ...draft,
    id: -1,
    reportId: -1,
    actual5dReturn: null,
    actual5dDirection: null,
    actual20dReturn: null,
    backfillStatus: 'pending',
    createdAt: '',
  };
}
