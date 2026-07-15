// 数据质量分档门禁 — 硬拦用「金价+锚定+极低分」，不用 conf<55 一刀切

import type { MarketData } from '../types/market.js';
import type { ValidationResult } from '../types/market.js';
import { isMissingPrice, isValidMarketNumber } from '../schemas/market.js';

/** green=高可信 / yellow=降级可用 / red=不可用（不出操作结论） */
export type DataQualityTier = 'green' | 'yellow' | 'red';

export interface DataQualityGateInput {
  marketData: MarketData;
  overallConfidence: number;
  validations?: ValidationResult[];
  warnings?: string[];
  /** 直连锚定金价（Yahoo/gold-api/新浪），无则 null */
  anchorGoldPrice?: number | null;
}

export interface DataQualityGate {
  tier: DataQualityTier;
  /** 是否允许给出定投/加减仓等操作结论 */
  actionable: boolean;
  overallConfidence: number;
  goldOk: boolean;
  anchorDeviationPct: number | null;
  reasons: string[];
  /** 控制台/MD 顶栏文案 */
  banners: string[];
  hasSingleSource: boolean;
  missingOptional: string[];
}

const HARD_CONF_FLOOR = 35;
const YELLOW_CONF = 60;
const GREEN_CONF = 70;
const ANCHOR_HARD_PCT = 3;
const ANCHOR_GREEN_PCT = 1;

function anchorDeviation(spot: number, anchor: number): number {
  return Math.abs((spot - anchor) / anchor) * 100;
}

/**
 * 评估数据质量分档。
 *
 * 硬拦（red / actionable=false）：
 *   - 伦敦金缺失或 ≤0
 *   - 有锚定且偏差 > 3%
 *   - 综合置信度 < 35
 *
 * 黄条（yellow，仍出报告）：
 *   - 35 ≤ conf < 60
 *   - 存在 single_source
 *   - 可选字段缺失（上海/ETF/DXY/利率/等）
 *
 * 绿灯（green）：
 *   - conf ≥ 70 且（无锚定或偏差 < 1%）
 */
export function evaluateDataQualityGate(input: DataQualityGateInput): DataQualityGate {
  const { marketData, overallConfidence, validations = [], warnings = [] } = input;
  const reasons: string[] = [];
  const banners: string[] = [];
  const missingOptional: string[] = [];

  const london = marketData.london?.price;
  const goldOk = !isMissingPrice(london) && isValidMarketNumber(london?.value);
  const spot = goldOk ? (london!.value as number) : null;

  let anchorDeviationPct: number | null = null;
  const anchor = input.anchorGoldPrice;
  if (spot != null && anchor != null && Number.isFinite(anchor) && anchor > 0) {
    anchorDeviationPct = Math.round(anchorDeviation(spot, anchor) * 100) / 100;
  }

  const hasSingleSource = validations.some(v => v.consensus === 'single_source')
    || warnings.some(w => w.includes('仅单源'));

  if (isMissingPrice(marketData.shanghai?.price)) missingOptional.push('上海金');
  if (isMissingPrice(marketData.etf?.nav)) missingOptional.push('ETF净值');
  if (isMissingPrice(marketData.dollarIndex?.value)) missingOptional.push('美元指数');
  if (isMissingPrice(marketData.usTreasury?.yield10y)) missingOptional.push('10Y美债');
  if (
    !marketData.usTreasury?.tips
    || marketData.usTreasury.tips.source === 'N/A'
    || !isValidMarketNumber(marketData.usTreasury.tips.value)
  ) {
    missingOptional.push('TIPS');
  }

  // —— 硬拦 ——
  if (!goldOk) {
    reasons.push('伦敦金价格缺失或无效');
  }
  if (anchorDeviationPct != null && anchorDeviationPct > ANCHOR_HARD_PCT) {
    reasons.push(`金价与锚定偏差 ${anchorDeviationPct.toFixed(2)}% > ${ANCHOR_HARD_PCT}%`);
  }
  if (overallConfidence < HARD_CONF_FLOOR) {
    reasons.push(`综合置信度 ${overallConfidence}% < ${HARD_CONF_FLOOR}%（数据整体不可靠）`);
  }

  if (reasons.length > 0) {
    banners.push('🔴 数据不合格：本报告操作建议仅供参考框架，请勿据此加减仓');
    banners.push(...reasons.map(r => `   · ${r}`));
    return {
      tier: 'red',
      actionable: false,
      overallConfidence,
      goldOk,
      anchorDeviationPct,
      reasons,
      banners,
      hasSingleSource,
      missingOptional,
    };
  }

  // —— 黄 / 绿 ——
  // 绿灯：conf≥70 且锚定贴合（可选字段缺失只作提示，不降档）
  const anchorOkForGreen = anchorDeviationPct == null || anchorDeviationPct < ANCHOR_GREEN_PCT;
  if (overallConfidence >= GREEN_CONF && anchorOkForGreen) {
    banners.push(`✅ 数据高可信（置信度 ${overallConfidence}%）`);
    if (missingOptional.length > 0) {
      banners.push(`   · 可选数据暂缺：${missingOptional.join('、')}（不影响金价主结论）`);
    }
    if (hasSingleSource) {
      banners.push('   · 部分次要字段仍为单源');
    }
    return {
      tier: 'green',
      actionable: true,
      overallConfidence,
      goldOk,
      anchorDeviationPct,
      reasons: [],
      banners,
      hasSingleSource,
      missingOptional,
    };
  }

  // yellow：可出报告与建议，但顶栏警告
  const yellowReasons: string[] = [];
  if (overallConfidence < YELLOW_CONF) {
    yellowReasons.push(`置信度 ${overallConfidence}%（降级可用，建议结合量化分与主力）`);
  } else {
    yellowReasons.push(`置信度 ${overallConfidence}%（未达绿灯 ${GREEN_CONF}% 或锚定偏差偏大）`);
  }
  if (hasSingleSource) yellowReasons.push('部分字段仅单源交叉');
  if (missingOptional.length > 0) {
    yellowReasons.push(`可选数据暂缺：${missingOptional.join('、')}`);
  }
  if (anchorDeviationPct != null && anchorDeviationPct >= ANCHOR_GREEN_PCT) {
    yellowReasons.push(`与锚定偏差 ${anchorDeviationPct.toFixed(2)}%（可接受但非最优）`);
  }

  banners.push('🟡 数据降级可用：已给出分析，请优先看置信度与缺失字段');
  banners.push(...yellowReasons.map(r => `   · ${r}`));

  return {
    tier: 'yellow',
    actionable: true,
    overallConfidence,
    goldOk,
    anchorDeviationPct,
    reasons: yellowReasons,
    banners,
    hasSingleSource,
    missingOptional,
  };
}

/** 红档时覆盖操作建议文案 */
export function nonActionableAdvice(): { headline: string; action: string } {
  return {
    headline: '数据质量不足，暂停依据本报告操作',
    action: '维持既有定投纪律或观望；修复数据后重新 analysis',
  };
}

export function formatDataQualityGateConsole(gate: DataQualityGate): string {
  const tierLabel = gate.tier === 'green' ? '🟢 高可信' : gate.tier === 'yellow' ? '🟡 降级可用' : '🔴 不可用';
  const lines = [
    `  📋 数据质量: ${tierLabel} | 置信度 ${gate.overallConfidence}% | 可操作=${gate.actionable ? '是' : '否'}`,
    ...gate.banners.map(b => (b.startsWith(' ') ? b : `  ${b}`)),
  ];
  if (gate.anchorDeviationPct != null) {
    lines.push(`  ⚓ 相对锚定偏差: ${gate.anchorDeviationPct.toFixed(2)}%`);
  }
  return lines.join('\n');
}

export function formatDataQualityGateMarkdown(gate: DataQualityGate): string {
  const tierLabel = gate.tier === 'green' ? '高可信 ✅' : gate.tier === 'yellow' ? '降级可用 ⚠️' : '不可用 🔴';
  const lines = [
    '## 📋 数据质量门禁',
    '',
    `- **分档**：${tierLabel}`,
    `- **综合置信度**：${gate.overallConfidence}%`,
    `- **可否依据本报告操作**：${gate.actionable ? '可以（仍须结合自身判断）' : '**否 — 请勿据此加减仓**'}`,
  ];
  if (gate.anchorDeviationPct != null) {
    lines.push(`- **金价 vs 锚定偏差**：${gate.anchorDeviationPct.toFixed(2)}%`);
  }
  if (gate.missingOptional.length) {
    lines.push(`- **暂缺字段**：${gate.missingOptional.join('、')}`);
  }
  if (gate.banners.length) {
    lines.push('');
    for (const b of gate.banners) {
      lines.push(`> ${b.trim()}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
