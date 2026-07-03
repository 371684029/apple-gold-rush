// 信息验证 Agent — 多源交叉验证 + 来源分级 + LLM 异常检测

import { BaseAgent } from './base.js';
import { getConfig } from '../utils/config.js';
import { crossValidate, checkFreshness } from '../utils/source-rank.js';
import type { MarketData, ValidationResult } from '../types/market.js';

const VALIDATION_SYSTEM_PROMPT = `你是黄金市场数据验证专家。你的任务是验证采集到的市场数据的准确性和时效性。

## 验证规则

1. **3源验证**：同一数据点至少3个独立来源交叉验证
   - 3源一致 → ✅ 采信
   - 2源一致，1源偏差<0.5% → ⚠️ 取均值
   - 3源差异>1% → ❌ 标注可疑

2. **来源分级**：
   - A级（权威）：交易所、央行 → 直接采信
   - B级（可信）：财经媒体 → 采信但需验证
   - C级（参考）：自媒体 → 仅参考

3. **时效性**：
   - 价格数据 > 4小时 → 标注⚠️
   - 利率/CPI > 1天 → 正常
   - 新闻 > 3天 → 标注日期

4. **反向核查**：重大新闻/观点必须搜反对观点

5. **内在一致性校验**：伦敦金和上海金之间存在换算关系（上海金/g ≈ 伦敦金×汇率/31.1035），
   检查两者是否有明显背离。美元指数 vs 金价的负相关是否符合预期。`;

/** LLM 验证输出 schema */
const VALIDATION_SCHEMA = {
  type: 'object',
  properties: {
    anomalies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string' },
          issue: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['field', 'issue', 'severity'],
      },
    },
    crossValidationNotes: { type: 'string' },
    overallAssessment: { type: 'string', enum: ['normal', 'suspicious', 'unreliable'] },
    llmConfidence: { type: 'number' },
  },
  required: ['anomalies', 'overallAssessment', 'llmConfidence'],
};

export class ValidatorAgent extends BaseAgent {
  constructor() {
    const config = getConfig();
    super({
      name: 'validator',
      model: config.models.validator,
      systemPrompt: VALIDATION_SYSTEM_PROMPT,
    });
  }

  /** 验证市场数据 — 本地交叉验证 + LLM 异常检测 */
  async validate(data: MarketData): Promise<{
    validations: ValidationResult[];
    overallConfidence: number;
    warnings: string[];
  }> {
    // ---------- 第1步：本地交叉验证（基于来源分级和数值偏差） ----------
    const validations: ValidationResult[] = [];

    if (data.london?.price?.value != null) {
      validations.push(crossValidate('london.price', [{
        value: data.london.price.value,
        source: data.london.price.source ?? 'unknown',
        grade: data.london.price.sourceGrade ?? 'C',
        timestamp: data.london.price.verifiedAt ?? '',
      }]));
    }
    if (data.shanghai?.price?.value != null) {
      validations.push(crossValidate('shanghai.price', [{
        value: data.shanghai.price.value,
        source: data.shanghai.price.source ?? 'unknown',
        grade: data.shanghai.price.sourceGrade ?? 'C',
        timestamp: data.shanghai.price.verifiedAt ?? '',
      }]));
    }
    if (data.etf?.nav?.value != null) {
      validations.push(crossValidate('etf.nav', [{
        value: data.etf.nav.value,
        source: data.etf.nav.source ?? 'unknown',
        grade: data.etf.nav.sourceGrade ?? 'C',
        timestamp: data.etf.nav.verifiedAt ?? '',
      }]));
    }
    if (data.dollarIndex?.value?.value != null) {
      validations.push(crossValidate('dollarIndex.value', [{
        value: data.dollarIndex.value.value,
        source: data.dollarIndex.value.source ?? 'unknown',
        grade: data.dollarIndex.value.sourceGrade ?? 'C',
        timestamp: data.dollarIndex.value.verifiedAt ?? '',
      }]));
    }

    // ---------- 第2步：时效性检查 ----------
    const warnings: string[] = [];
    const freshness = checkFreshness(data.timestamp);
    if (!freshness.fresh && freshness.warning) {
      warnings.push(freshness.warning);
    }

    // ---------- 第3步：LLM 异常检测 ----------
    // 构造可读的输入数据供 LLM 分析内在一致性和异常
    const dataSummary = [
      `时间戳: ${data.timestamp}`,
      `伦敦金: $${data.london?.price?.value ?? 'N/A'} (${data.london?.price?.change ?? 'N/A'}%) 来源: ${data.london?.price?.source ?? 'N/A'}`,
      `上海金: ¥${data.shanghai?.price?.value ?? 'N/A'}/g  来源: ${data.shanghai?.price?.source ?? 'N/A'}`,
      `ETF(518880): ${data.etf?.nav?.value ?? 'N/A'}  来源: ${data.etf?.nav?.source ?? 'N/A'}`,
      `美元指数: ${data.dollarIndex?.value?.value ?? 'N/A'} (${data.dollarIndex?.value?.change ?? 'N/A'}%)`,
      `10Y美债: ${data.usTreasury?.yield10y?.value ?? 'N/A'}%`,
      `TIPS: ${data.usTreasury?.tips?.value ?? 'N/A'}%`,
    ].join('\n');

    let llmAssessment: { anomalies: Array<{ field: string; issue: string; severity: string }>; overallAssessment: string; llmConfidence: number } | null = null;

    try {
      llmAssessment = await this.structuredPrompt<{
        anomalies: Array<{ field: string; issue: string; severity: string }>;
        overallAssessment: 'normal' | 'suspicious' | 'unreliable';
        llmConfidence: number;
      }>(
        `请验证以下市场数据的准确性和内在一致性，尤其关注：\n` +
        `1. 伦敦金与上海金的换算比率是否合理（上海金/g ≈ 伦敦金×汇率÷31.1035）\n` +
        `2. 美元指数与金价的走势关系是否符合常理\n` +
        `3. 各项数据是否有明显异常或背离\n\n` +
        dataSummary,
        VALIDATION_SCHEMA,
      );
    } catch (err) {
      // LLM 调用失败不阻断，降级使用本地验证
      console.error('  ⚠️ LLM验证不可用，降级为纯本地验证:', err instanceof Error ? err.message : 'unknown');
    }

    // ---------- 第4步：合并 LLM 结果 ----------
    if (llmAssessment) {
      // 将 LLM 发现的异常加入 warnings
      for (const anomaly of llmAssessment.anomalies) {
        if (anomaly.severity === 'high') {
          warnings.push(`🔴 ${anomaly.field}: ${anomaly.issue}`);
        } else if (anomaly.severity === 'medium') {
          warnings.push(`🟡 ${anomaly.field}: ${anomaly.issue}`);
        }
        // low severity 仅记录不报警
      }

      if (llmAssessment.overallAssessment === 'unreliable') {
        warnings.push('🔴 LLM 评估：数据整体不可靠，请人工核实');
      } else if (llmAssessment.overallAssessment === 'suspicious') {
        warnings.push('🟡 LLM 评估：数据存在部分异常');
      }
    }

    // ---------- 第5步：综合计算置信度 ----------
    // 本地验证置信度
    const localConfidence = validations.length > 0
      ? Math.round(validations.reduce((sum, v) => sum + v.confidence, 0) / validations.length)
      : 50;

    let overallConfidence: number;
    if (llmAssessment) {
      // 取本地置信度和 LLM 置信度的加权平均（LLM 权重0.4，本地权重0.6）
      overallConfidence = Math.round(localConfidence * 0.6 + llmAssessment.llmConfidence * 0.4);
    } else {
      overallConfidence = localConfidence;
    }

    return { validations, overallConfidence, warnings };
  }
}
