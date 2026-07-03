// 裁决摘要 — 本地汇总看多/看空博弈，无需额外 LLM

import type { RebuttalAnalysis, TechnicalAnalysis, FundamentalAnalysis, SentimentAnalysis } from '../types/analysis.js';
import type { ScoreBreakdown } from './score-breakdown.js';

export interface JudgeVerdict {
  summary: string;
  bullPointCount: number;
  bearPointCount: number;
  keyTurningPoint: string;
}

/** 生成简短裁决摘要 */
export function buildJudgeVerdict(
  technical: Pick<TechnicalAnalysis, 'score' | 'keyPoints'>,
  fundamental: Pick<FundamentalAnalysis, 'score' | 'keyPoints'>,
  sentiment: Pick<SentimentAnalysis, 'score' | 'keyPoints'>,
  rebuttal: Pick<RebuttalAnalysis, 'bearPoints' | 'rebuttalStrength' | 'bearScore'>,
  breakdown: ScoreBreakdown,
): JudgeVerdict {
  const bullPointCount =
    (technical.keyPoints?.length ?? 0)
    + (fundamental.keyPoints?.length ?? 0)
    + (sentiment.keyPoints?.length ?? 0);

  const bearPointCount = rebuttal.bearPoints?.length ?? 0;
  const delta = breakdown.rebuttal.roundedDelta;
  const deltaStr = delta > 0 ? `+${delta}` : String(delta);

  const avgBull = breakdown.initialScore;
  const bear = rebuttal.bearScore;

  let tilt: string;
  if (delta <= -5) tilt = '反驳显著压低综合分，需重视下行风险';
  else if (delta < 0) tilt = '反驳适度修正，维持谨慎偏多/中性';
  else if (delta === 0) tilt = '反驳未能改变综合分，多空证据大致均衡';
  else tilt = '看空论据不足，综合分略上调';

  const topBear = rebuttal.bearPoints?.[0]?.point ?? '暂无';
  const topBull = technical.keyPoints?.[0] ?? fundamental.keyPoints?.[0] ?? '暂无';

  const keyTurningPoint =
    bear >= avgBull + 10
      ? `看空力度(${bear})高于三维度均分(${avgBull})，关键空方：${topBear.slice(0, 40)}`
      : `多方均分(${avgBull})相对占优，关键空方：${topBear.slice(0, 40)}；关键多方：${String(topBull).slice(0, 40)}`;

  const summary =
    `看多论据约 ${bullPointCount} 条 vs 看空 ${bearPointCount} 条 → `
    + `反驳(${rebuttal.rebuttalStrength}) ${deltaStr} 分 → 最终 ${breakdown.finalScore} 分；${tilt}`;

  return { summary, bullPointCount, bearPointCount, keyTurningPoint };
}

export function formatJudgeVerdictMarkdown(v: JudgeVerdict): string[] {
  return [
    '## ⚖️ 裁决摘要',
    '',
    `- ${v.summary}`,
    `- 关键翻转点：${v.keyTurningPoint}`,
    '',
  ];
}

export function formatJudgeVerdictConsole(v: JudgeVerdict, indent = '  '): string {
  return [
    `${indent}⚖️ 裁决摘要`,
    `${indent}  ${v.summary}`,
    `${indent}  关键翻转点：${v.keyTurningPoint}`,
  ].join('\n');
}
