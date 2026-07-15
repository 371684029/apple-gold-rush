// 双打分机制：LLM 分 vs 量化分 — 并存、分别校准、冲突有规则
//
// 原则：
// 1. 两套分数始终同时展示，不合成一个黑箱分
// 2. |LLM−量化| > 15 视为冲突 → 操作弃权（维持定投），仍展示双分
// 3. 弱维度一致性 → 同样弃权
// 4. 谁更准由 calibrate 分轨统计决定，不在此写死「永远跟量化」

import type { Direction } from '../types/analysis.js';

/** 冲突阈值：绝对分差 */
export const DUAL_CONFLICT_THRESHOLD = 15;
/** 温和偏差上限 */
export const DUAL_MILD_GAP = 8;

export type DualAlignment = 'aligned' | 'mild_gap' | 'conflict' | 'quant_missing';

export type DualActionPolicy =
  | 'both'              // 同向且偏差小，可参考综合结论
  | 'quant_preferred'   // 偏差中等：操作偏向量化，叙事仍用 LLM
  | 'hold_on_conflict'  // 冲突或弱一致：维持定投、不站队
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

export function dualDirectionFromScore(score: number): Direction {
  if (score >= 58) return 'bullish';
  if (score <= 42) return 'bearish';
  return 'neutral';
}

export function dirLabel(d: Direction): string {
  if (d === 'bullish') return '偏多';
  if (d === 'bearish') return '偏空';
  return '中性';
}

/**
 * 评估双打分关系与操作策略。
 * @param consistencyWeak 四维度一致性弱（≤2/4）
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
  const llmDirection = dualDirectionFromScore(llmScore);

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
  const quantDirection = dualDirectionFromScore(q);
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

  // 弱一致性 / 分差冲突 → 弃权（不站队）
  if (opts?.consistencyWeak || alignment === 'conflict' || (alignment === 'mild_gap' && !sameDirection)) {
    const reasons: string[] = [];
    if (opts?.consistencyWeak) reasons.push('四维度一致性弱');
    if (alignment === 'conflict') {
      reasons.push(`|LLM−量化|=${abs}>${DUAL_CONFLICT_THRESHOLD}`);
    }
    if (alignment === 'mild_gap' && !sameDirection) {
      reasons.push(`方向不一致（LLM${dirLabel(llmDirection)} vs 量化${dirLabel(quantDirection)}）`);
    }

    banners.push(`🔢 双打分冲突/不确定：LLM=${llmScore}（${dirLabel(llmDirection)}）· 量化=${q}（${dirLabel(quantDirection)}）· 偏差=${delta > 0 ? '+' : ''}${delta}`);
    banners.push(`   · 原因：${reasons.join('；')}`);
    banners.push('   · 策略：两套分数均展示；操作弃权 → 维持定投，不据此加减仓');
    banners.push('   · 以 calibrate 分轨结果判断近期谁更准，勿无脑抬某一侧权重');

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
      actionOverride: {
        headline: '双体系不一致，操作弃权',
        action: '维持基础定投，按日历执行；待 LLM 与量化同向或校准明确后再考虑加减仓',
      },
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
    lines.push(`- ⛔ **操作覆盖**：${v.actionOverride.headline} — ${v.actionOverride.action}`);
  }
  for (const b of v.banners) {
    lines.push(`- ${b.replace(/^[🔢\s·]+/, '').trim()}`);
  }
  lines.push('');
  lines.push('> 双打分独立存在、分别校准（`goldrush calibrate`）。冲突时弃权维持定投，不用「提高某一侧权重」掩盖分歧。');
  lines.push('');
  return lines.join('\n');
}

/** 方向命中：score>55 预测涨，<45 预测跌，中间不计入 */
export function predictDirectionFromScore(score: number): 'up' | 'down' | null {
  if (score > 55) return 'up';
  if (score < 45) return 'down';
  return null;
}

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
