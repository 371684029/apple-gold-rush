// Smart 模式 — 平稳日复用上一报告，零 LLM

import type { GoldAnalysisReport } from '../types/analysis.js';
import type { AnalysisGateResult } from './analysis-gate.js';
import type { MacroRegime } from './macro-regime.js';

export interface SmartAnalysisMeta {
  mode: 'smart';
  gate: AnalysisGateResult;
  sourceReportDate: string;
}

/** 基于上一日报告生成平稳日简版（不调用 LLM） */
export function buildSmartReport(
  previous: GoldAnalysisReport,
  macroRegime: MacroRegime,
  gate: AnalysisGateResult,
  sourceDate: string,
): GoldAnalysisReport {
  const now = new Date().toISOString();
  const calmNote = `【Smart 平稳日】${gate.reason}，维持上一日（${sourceDate}）研判，无需深度 LLM 分析。`;

  return {
    ...previous,
    timestamp: now,
    macroRegime,
    dataQuality: {
      overallConfidence: previous.dataQuality?.overallConfidence ?? 70,
      warnings: [
        calmNote,
        ...(previous.dataQuality?.warnings ?? []).filter(w => !w.startsWith('【Smart')),
      ],
    },
    overall: {
      ...previous.overall,
      shortTerm: {
        ...previous.overall.shortTerm,
        action: '观望/维持 — 波动平稳，沿用上一日短期策略',
        riskWarning: `${calmNote} ${previous.overall.shortTerm?.riskWarning ?? ''}`.trim(),
      },
      midTerm: {
        ...previous.overall.midTerm,
        investAdvice: {
          ...previous.overall.midTerm.investAdvice,
          dipInvest: previous.overall.midTerm.investAdvice?.dipInvest ?? 'continue',
          positionAdjust: 'hold',
        },
        riskWarning: `${calmNote} ${previous.overall.midTerm?.riskWarning ?? ''}`.trim(),
      },
    },
    scenarioProbSource: previous.scenarioProbSource,
    causalChains: previous.causalChains,
  };
}

export function parseReportJson(json: string): GoldAnalysisReport | null {
  try {
    return JSON.parse(json) as GoldAnalysisReport;
  } catch {
    return null;
  }
}
