// 双打分机制：LLM 分 vs 量化分 — 并存、分别校准、冲突有规则
//
// 原则：
// 1. 两套分数始终同时展示，不合成一个黑箱分
// 2. |LLM−量化| > 15 或方向相反 → 操作克制（仓位有上限），不抬某一侧权重
// 3. 四维弱一致 ≠「双体系不一致」：仅作克制提示，不盖掉双分同向时的仓位结论
// 4. 冲突文案必须可解释（谁偏哪边、差多少），避免千篇一律「双体系不一致」
// 5. 谁更准由 calibrate 分轨统计决定，不在此写死「永远跟量化」

import type { Direction } from '../types/analysis.js';
import { directionFromScore } from './decision-thresholds.js';

/** 冲突阈值：绝对分差 */
export const DUAL_CONFLICT_THRESHOLD = 15;
/** 温和偏差上限 */
export const DUAL_MILD_GAP = 8;

export type DualAlignment = 'aligned' | 'mild_gap' | 'conflict' | 'quant_missing';

export type DualActionPolicy =
  | 'both'              // 同向且偏差小，可参考综合结论
  | 'quant_preferred'   // 偏差中等：操作偏向量化，叙事仍用 LLM
  | 'hold_on_conflict'  // 双分冲突：仓位受限、不追单边
  | 'llm_only';          // 无量化分

export interface DualScoreVerdict {
  llmScore: number;
  quantScore: number | null;
  /** LLM − 量化；无量化时为 null */
  delta: number | null;
  alignment: DualAlignment;
  llmDirection: Direction;
  quantDirection: Direction | null;
  sameDirection: boolean | null;
  actionPolicy: DualActionPolicy;
  banners: string[];
  /** 需要覆盖操作建议时非 null */
  actionOverride: { headline: string; action: string } | null;
}

export { directionFromScore as dualDirectionFromScore } from './decision-thresholds.js';

export function dirLabel(d: Direction): string {
  if (d === 'bullish') return '偏多';
  if (d === 'bearish') return '偏空';
  return '中性';
}

/** 构建可解释的冲突覆盖文案（给人看，忌空话） */
export function buildDualConflictOverride(input: {
  llmScore: number;
  quantScore: number;
  llmDirection: Direction;
  quantDirection: Direction;
  delta: number;
  sameDirection: boolean;
}): { headline: string; action: string } {
  const { llmScore, quantScore, llmDirection, quantDirection, delta, sameDirection } = input;
  const dStr = `${delta > 0 ? '+' : ''}${delta}`;
  const oppositeExtreme =
    (llmDirection === 'bullish' && quantDirection === 'bearish')
    || (llmDirection === 'bearish' && quantDirection === 'bullish');

  if (oppositeExtreme) {
    return {
      headline: `方向对立：LLM ${dirLabel(llmDirection)}${llmScore} vs 量化 ${dirLabel(quantDirection)}${quantScore}`,
      action: `两边对着干（Δ${dStr}），不追单边；维持定投，仓位见下方建议（已限≤50%）`,
    };
  }

  if (!sameDirection) {
    // 一方中性、一方偏多/空：幅度/阶段分歧，不是「体系坏了」
    return {
      headline: `LLM ${dirLabel(llmDirection)}${llmScore} / 量化 ${dirLabel(quantDirection)}${quantScore}：阶段判断不完全一致`,
      action: `分差 Δ${dStr}，取均值偏克制；定投层为主，波段仓先放轻，看下方仓位%`,
    };
  }

  // 同向但分差大：哪边更极端
  const llmMoreExtreme = Math.abs(llmScore - 50) > Math.abs(quantScore - 50);
  const extremeSide = llmMoreExtreme ? 'LLM' : '量化';
  return {
    headline: `同向${dirLabel(llmDirection)}但分差偏大（Δ${dStr}）：${extremeSide}更极端`,
    action: `两边都偏${dirLabel(llmDirection)}，幅度不一；维持定投节奏，仓位按下方均值建议执行`,
  };
}

/**
 * 仓位算完后：把双分 actionOverride 与仓位结论对齐（同一 headline + 具体仓位% action）
 * 避免「综合研判 / 双打分 / 策略风险提示」各写一套。
 */
export function alignDualOverrideWithPosition(
  dual: DualScoreVerdict,
  position: { headline: string; action: string } | null | undefined,
): void {
  if (!dual.actionOverride) return;
  if (dual.actionPolicy !== 'hold_on_conflict') return;
  // 数据门禁覆盖不与仓位混写
  if (dual.actionOverride.headline.includes('数据质量不足')) return;
  if (!position?.action) return;

  dual.actionOverride = {
    headline: position.headline || dual.actionOverride.headline,
    action: position.action,
  };
}

/**
 * 评估双打分关系与操作策略。
 * @param consistencyWeak 四维度一致性弱（≤2/4）— 单独不足以标成「双体系不一致」
 * @param dataActionable 数据门禁是否允许操作（红档 false）
 */
export function evaluateDualScore(
  llmScore: number,
  quantScore: number | null | undefined,
  opts?: {
    consistencyWeak?: boolean;
    dataActionable?: boolean;
  },
): DualScoreVerdict {
  const banners: string[] = [];
  const llmDirection = directionFromScore(llmScore);

  if (quantScore == null || !Number.isFinite(quantScore)) {
    banners.push('🔢 双打分：仅有 LLM 分（量化分缺失，请检查金价历史是否充足）');
    return {
      llmScore,
      quantScore: null,
      delta: null,
      alignment: 'quant_missing',
      llmDirection,
      quantDirection: null,
      sameDirection: null,
      actionPolicy: 'llm_only',
      banners,
      actionOverride: null,
    };
  }

  const q = Math.round(quantScore);
  const delta = Math.round(llmScore - q);
  const abs = Math.abs(delta);
  const quantDirection = directionFromScore(q);
  const sameDirection = llmDirection === quantDirection;

  let alignment: DualAlignment;
  if (abs <= DUAL_MILD_GAP) alignment = 'aligned';
  else if (abs <= DUAL_CONFLICT_THRESHOLD) alignment = 'mild_gap';
  else alignment = 'conflict';

  // 数据红档：上层 data-quality-gate 已关操作；此处只加说明
  if (opts?.dataActionable === false) {
    banners.push(`🔢 双打分：LLM=${llmScore} · 量化=${q} · 偏差=${delta > 0 ? '+' : ''}${delta}`);
    banners.push('   · 数据门禁红档：操作结论已关闭（与双分无关）');
    return {
      llmScore,
      quantScore: q,
      delta,
      alignment,
      llmDirection,
      quantDirection,
      sameDirection,
      actionPolicy: 'hold_on_conflict',
      banners,
      actionOverride: {
        headline: '数据质量不足，暂停依据本报告操作',
        action: '维持既有定投纪律或观望；修复数据后重新 analysis',
      },
    };
  }

  // 真正的双分冲突：分差大，或同档内方向不一致
  const dualConflict =
    alignment === 'conflict'
    || (alignment === 'mild_gap' && !sameDirection);

  if (dualConflict) {
    const reasons: string[] = [];
    if (alignment === 'conflict') {
      reasons.push(`|LLM−量化|=${abs}>${DUAL_CONFLICT_THRESHOLD}`);
    }
    if (!sameDirection) {
      reasons.push(`方向不一致（LLM${dirLabel(llmDirection)} vs 量化${dirLabel(quantDirection)}）`);
    }
    if (opts?.consistencyWeak) {
      reasons.push('四维度一致性弱（附加）');
    }

    const override = buildDualConflictOverride({
      llmScore,
      quantScore: q,
      llmDirection,
      quantDirection,
      delta,
      sameDirection,
    });

    banners.push(
      `🔢 双打分分歧：LLM=${llmScore}（${dirLabel(llmDirection)}）· 量化=${q}（${dirLabel(quantDirection)}）· 偏差=${delta > 0 ? '+' : ''}${delta}`,
    );
    banners.push(`   · 原因：${reasons.join('；')}`);
    banners.push('   · 策略：双分并排展示；不抬某一侧权重；仓位取均值并设上限，定投层为主');
    banners.push('   · 以 calibrate 分轨结果判断近期谁更准');

    return {
      llmScore,
      quantScore: q,
      delta,
      alignment: alignment === 'aligned' ? 'mild_gap' : alignment,
      llmDirection,
      quantDirection,
      sameDirection,
      actionPolicy: 'hold_on_conflict',
      banners,
      actionOverride: override,
    };
  }

  // 四维弱一致、但双分未冲突：只提示克制，不写「双体系不一致」、不强制弃权覆盖
  if (opts?.consistencyWeak) {
    banners.push(
      `🔢 双打分${alignment === 'aligned' ? '一致' : '温和偏差'}：LLM=${llmScore} · 量化=${q} · 偏差=${delta > 0 ? '+' : ''}${delta}`,
    );
    banners.push('   · 四维度一致性弱：操作宜克制，仓位已设上限；非双体系对立');
    if (alignment === 'mild_gap') {
      banners.push('   · 叙事看 LLM；短线结构可参考量化');
      return {
        llmScore,
        quantScore: q,
        delta,
        alignment,
        llmDirection,
        quantDirection,
        sameDirection,
        actionPolicy: 'quant_preferred',
        banners,
        actionOverride: null,
      };
    }
    return {
      llmScore,
      quantScore: q,
      delta,
      alignment,
      llmDirection,
      quantDirection,
      sameDirection,
      actionPolicy: 'both',
      banners,
      actionOverride: null,
    };
  }

  if (alignment === 'mild_gap') {
    banners.push(`🔢 双打分温和偏差：LLM=${llmScore} · 量化=${q} · 偏差=${delta > 0 ? '+' : ''}${delta}（同向）`);
    banners.push('   · 叙事看 LLM；短线结构可参考量化；操作仍宜克制');
    return {
      llmScore,
      quantScore: q,
      delta,
      alignment,
      llmDirection,
      quantDirection,
      sameDirection,
      actionPolicy: 'quant_preferred',
      banners,
      actionOverride: null,
    };
  }

  // aligned
  banners.push(`🔢 双打分一致：LLM=${llmScore} · 量化=${q} · 偏差=${delta > 0 ? '+' : ''}${delta}（均${dirLabel(llmDirection)}）`);
  return {
    llmScore,
    quantScore: q,
    delta,
    alignment: 'aligned',
    llmDirection,
    quantDirection,
    sameDirection: true,
    actionPolicy: 'both',
    banners,
    actionOverride: null,
  };
}

export function formatDualScoreConsole(v: DualScoreVerdict, indent = '  '): string {
  return v.banners.map(b => (b.startsWith(' ') ? `${indent}${b.trimStart()}` : `${indent}${b}`)).join('\n');
}

export function formatDualScoreMarkdown(v: DualScoreVerdict): string {
  const lines = [
    '## ⚖️ 双打分机制（LLM × 量化）',
    '',
    '| 体系 | 分数 | 方向 |',
    '|------|------|------|',
    `| LLM（四维+反驳+校准） | **${v.llmScore}/100** | ${dirLabel(v.llmDirection)} |`,
    `| 量化（纯本地因子） | **${v.quantScore ?? 'N/A'}/100** | ${v.quantDirection ? dirLabel(v.quantDirection) : 'N/A'} |`,
  ];
  if (v.delta != null) {
    lines.push(`| 偏差 (LLM−量化) | **${v.delta > 0 ? '+' : ''}${v.delta}** | ${v.alignment} |`);
  }
  lines.push('');
  lines.push(`- **对齐状态**：\`${v.alignment}\``);
  lines.push(`- **操作策略**：\`${v.actionPolicy}\``);
  if (v.actionOverride) {
    lines.push(`- ⚠️ **分歧说明**：${v.actionOverride.headline} — ${v.actionOverride.action}`);
  }
  for (const b of v.banners) {
    lines.push(`- ${b.replace(/^[🔢\s·]+/, '').trim()}`);
  }
  lines.push('');
  lines.push('> 双打分独立存在、分别校准（`goldrush calibrate`）。冲突时不抬某一侧权重；仓位取均值并设上限，以具体%为准。');
  lines.push('');
  return lines.join('\n');
}

export { predictDirectionFromScore } from './decision-thresholds.js';

export interface DualTrackHitStats {
  llmHits: number;
  llmTotal: number;
  quantHits: number;
  quantTotal: number;
  conflictDays: number;
  /** 冲突日若跟量化，方向命中 */
  conflictFollowQuantHits: number;
  conflictFollowLlmHits: number;
}

export function emptyDualTrackHitStats(): DualTrackHitStats {
  return {
    llmHits: 0, llmTotal: 0,
    quantHits: 0, quantTotal: 0,
    conflictDays: 0,
    conflictFollowQuantHits: 0,
    conflictFollowLlmHits: 0,
  };
}
