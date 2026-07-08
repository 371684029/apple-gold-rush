// 情景概率统计化 — 基于历史相似日 5 日收益分布

import type { PatternMatch } from '../types/calibration.js';
import type { Scenarios } from '../types/analysis.js';

export interface ScenarioProbabilities {
  base: number;
  upside: number;
  downside: number;
  sampleSize: number;
  source: 'historical' | 'insufficient';
  note: string;
}

const UPSIDE_THRESHOLD = 1.0;
const DOWNSIDE_THRESHOLD = -1.0;

/** 从已回填相似日统计三情景概率 */
export function computeScenarioProbabilities(matches: PatternMatch[]): ScenarioProbabilities {
  const filled = matches.filter(m => m.actual5dReturn != null);
  if (filled.length < 3) {
    return {
      base: 50,
      upside: 25,
      downside: 25,
      sampleSize: filled.length,
      source: 'insufficient',
      note: `相似日样本 ${filled.length} 不足 3，保留默认概率`,
    };
  }

  let up = 0;
  let down = 0;
  let base = 0;
  for (const m of filled) {
    const r = m.actual5dReturn!;
    if (r >= UPSIDE_THRESHOLD) up++;
    else if (r <= DOWNSIDE_THRESHOLD) down++;
    else base++;
  }

  const n = filled.length;
  let pUp = Math.round((up / n) * 100);
  let pDown = Math.round((down / n) * 100);
  let pBase = 100 - pUp - pDown;

  if (pDown < 15) {
    const need = 15 - pDown;
    pDown = 15;
    pBase = Math.max(0, pBase - need);
    if (pUp + pBase + pDown > 100) pUp = 100 - pDown - pBase;
  }

  const sum = pBase + pUp + pDown;
  if (sum !== 100) {
    pBase += 100 - sum;
  }

  return {
    base: pBase,
    upside: pUp,
    downside: pDown,
    sampleSize: n,
    source: 'historical',
    note: `基于 ${n} 个相似日 5 日收益（涨≥${UPSIDE_THRESHOLD}%/跌≤${DOWNSIDE_THRESHOLD}%）`,
  };
}

/** 将统计概率写入情景（保留 LLM 叙述） */
export function applyScenarioProbabilities(
  scenarios: Scenarios,
  probs: ScenarioProbabilities,
): Scenarios {
  if (probs.source !== 'historical') return scenarios;
  return {
    base: { ...scenarios.base, probability: probs.base },
    upside: { ...scenarios.upside, probability: probs.upside },
    downside: { ...scenarios.downside, probability: probs.downside },
  };
}

export function formatScenarioProbLine(probs: ScenarioProbabilities): string {
  if (probs.source === 'historical') {
    return `统计概率（${probs.note}）：基准 ${probs.base}% / 上行 ${probs.upside}% / 下行 ${probs.downside}%`;
  }
  return probs.note;
}
