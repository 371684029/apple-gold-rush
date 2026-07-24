// 校准回测逻辑
import Database from 'better-sqlite3';
import { ReportsRepo, type AnalysisReportRow } from './reports.js';
import { GoldPricesRepo } from './gold-prices.js';
import { ScenarioFeaturesRepo } from './scenario-features.js';
import type { GoldAnalysisReport } from '../types/analysis.js';
import type { Direction } from '../types/analysis.js';
import type { CalibrationBucket, CalibrationReport, RiskAlertQuality } from '../types/calibration.js';
import { SCORE_BUCKETS, scoreBucketRange } from '../utils/score-buckets.js';
import {
  DUAL_CONFLICT_THRESHOLD,
  emptyDualTrackHitStats,
  predictDirectionFromScore,
  type DualTrackHitStats,
} from '../utils/dual-score.js';

/** 有效金价：>0 才参与校准（排除脏 0 / 缺失） */
function validClose(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v) && v > 0;
}

/** 报告 JSON 标记数据红档则排除（健全双打分：坏样本不进准确率） */
function isReportDataRed(reportJson: string): boolean {
  try {
    const j = JSON.parse(reportJson) as {
      dataQuality?: { overallConfidence?: number; warnings?: string[] };
    };
    const conf = j.dataQuality?.overallConfidence;
    if (conf != null && conf < 35) return true;
    const ws = j.dataQuality?.warnings ?? [];
    return ws.some(w =>
      /操作结论已关闭|数据不合格|数据门禁.*红|请勿据此加减仓/.test(w),
    );
  } catch {
    return false;
  }
}

export class CalibrationRepo {
  private reports: ReportsRepo;
  private prices: GoldPricesRepo;
  private features: ScenarioFeaturesRepo;

  constructor(private db: Database.Database) {
    this.reports = new ReportsRepo(db);
    this.prices = new GoldPricesRepo(db);
    this.features = new ScenarioFeaturesRepo(db);
  }

  /** 自动回填待回填的特征记录 */
  backfillPending(): number {
    const pending = this.features.getPendingBackfill();
    let filled = 0;

    for (const feature of pending) {
      const report = this.reports.getByDate(feature.date);
      if (!report) continue;

      const priceOnDate = this.prices.getByDate(feature.date);
      if (!priceOnDate?.londonClose) continue;

      // 查找5天后的金价
      const after5d = this.prices.getAfter(feature.date, 5);
      const price5d = after5d.length >= 5 ? after5d[4] : after5d.length > 0 ? after5d[after5d.length - 1] : null;

      if (price5d?.londonClose) {
        const return5d = (price5d.londonClose - priceOnDate.londonClose) / priceOnDate.londonClose * 100;
        const direction5d = return5d > 0.1 ? 'up' : return5d < -0.1 ? 'down' : 'flat';

        // 查找20天后的金价
        const after20d = this.prices.getAfter(feature.date, 20);
        const price20d = after20d.length >= 20 ? after20d[19] : null;
        const return20d = price20d?.londonClose
          ? (price20d.londonClose - priceOnDate.londonClose) / priceOnDate.londonClose * 100
          : null;

        this.features.backfill(feature.id, return5d, direction5d, return20d);
        filled++;
      }
    }
    return filled;
  }

  /** 过滤：有效金价 + 非数据红档 */
  private eligibleReports(days: number): AnalysisReportRow[] {
    return this.reports.getRecent(days).filter(r => {
      if (isReportDataRed(r.reportJson)) return false;
      const p = this.prices.getByDate(r.date);
      return validClose(p?.londonClose ?? null);
    });
  }

  /** 双打分方向命中与冲突日统计（5 日标签） */
  computeDualTrackHitStats(days: number, T: number = 5): DualTrackHitStats {
    const stats = emptyDualTrackHitStats();
    const reports = this.eligibleReports(days);

    for (const report of reports) {
      const currentPrice = this.prices.getByDate(report.date);
      const futurePrices = this.prices.getAfter(report.date, T)
        .filter(p => validClose(p.londonClose));
      const futurePrice = futurePrices.length >= T ? futurePrices[T - 1] : futurePrices[futurePrices.length - 1];
      if (!validClose(currentPrice?.londonClose) || !validClose(futurePrice?.londonClose)) continue;

      const futureReturn =
        (futurePrice.londonClose - currentPrice!.londonClose!) / currentPrice!.londonClose! * 100;
      const actualUp = futureReturn > 0.1;
      const actualDown = futureReturn < -0.1;
      if (!actualUp && !actualDown) continue; // flat 不计入方向命中

      const llmPred = predictDirectionFromScore(report.overallScore);
      if (llmPred) {
        stats.llmTotal++;
        if ((llmPred === 'up' && actualUp) || (llmPred === 'down' && actualDown)) stats.llmHits++;
      }

      if (report.quantScore != null) {
        const qPred = predictDirectionFromScore(report.quantScore);
        if (qPred) {
          stats.quantTotal++;
          if ((qPred === 'up' && actualUp) || (qPred === 'down' && actualDown)) stats.quantHits++;
        }

        const abs = Math.abs(report.overallScore - report.quantScore);
        if (abs > DUAL_CONFLICT_THRESHOLD && llmPred && qPred) {
          stats.conflictDays++;
          if ((qPred === 'up' && actualUp) || (qPred === 'down' && actualDown)) {
            stats.conflictFollowQuantHits++;
          }
          if ((llmPred === 'up' && actualUp) || (llmPred === 'down' && actualDown)) {
            stats.conflictFollowLlmHits++;
          }
        }
      }
    }
    return stats;
  }

  /** 计算校准报告（LLM overall_score；排除红档/无效价） */
  computeCalibration(days: number, T: number = 5): CalibrationReport {
    const allRecent = this.reports.getRecent(days);
    const reports = this.eligibleReports(days);
    const report = this.buildLlmCalibration(reports, days, T);
    const excluded = allRecent.length - reports.length;
    if (excluded > 0) {
      report.recommendations.push(`已排除 ${excluded} 条样本（数据红档或无效金价），不计入 LLM 校准`);
    }
    return report;
  }

  /** 按日期闭区间做 LLM 校准（walk-forward 用） */
  computeCalibrationInRange(from: string, to: string, T: number = 5): CalibrationReport {
    const days = 800;
    const reports = this.eligibleReports(days).filter(r => r.date >= from && r.date <= to);
    const span = Math.max(
      1,
      Math.ceil((Date.parse(to) - Date.parse(from)) / (24 * 3600 * 1000)) || 1,
    );
    return this.buildLlmCalibration(reports, span, T);
  }

  private buildLlmCalibration(reports: AnalysisReportRow[], days: number, T: number): CalibrationReport {
    const dateRange = reports.length > 0
      ? { from: reports[reports.length - 1].date, to: reports[0].date }
      : { from: 'N/A', to: 'N/A' };

    const buckets: CalibrationBucket[] = [];
    let totalValid = 0;

    for (const { range, min, max } of SCORE_BUCKETS) {
      const isLast = max === 100;
      const matching = reports.filter(r => r.overallScore >= min && (isLast ? r.overallScore <= max : r.overallScore < max));
      if (matching.length === 0) continue;

      let upCount = 0;
      let totalReturn = 0;
      let validCount = 0;

      for (const report of matching) {
        const currentPrice = this.prices.getByDate(report.date);
        const futurePrices = this.prices.getAfter(report.date, T).filter(p => validClose(p.londonClose));
        const futurePrice = futurePrices.length >= T ? futurePrices[T - 1] : null;

        if (!validClose(currentPrice?.londonClose) || !validClose(futurePrice?.londonClose)) continue;

        const futureReturn = (futurePrice.londonClose - currentPrice!.londonClose!) / currentPrice!.londonClose! * 100;
        if (futureReturn > 0) upCount++;
        totalReturn += futureReturn;
        validCount++;
      }

      if (validCount === 0) continue;
      totalValid += validCount;

      const avgReturn = totalReturn / validCount;
      const actualUpProbability = upCount / validCount;
      const midScore = (min + max) / 2;
      const calibrationError = Math.abs(midScore - actualUpProbability * 100);

      const predictedDirection: Direction = midScore > 50 ? 'bullish' : midScore < 50 ? 'bearish' : 'neutral';

      buckets.push({
        scoreRange: range,
        sampleSize: validCount,
        predictedDirection,
        actualUpCount: upCount,
        actualUpProbability,
        avgReturn,
        calibrationError,
        systematicBias: calibrationError < 5 ? 'calibrated'
          : midScore > actualUpProbability * 100 ? 'optimistic' : 'pessimistic',
      });
    }

    const overallBias = buckets.length > 0
      ? buckets.reduce((sum, b) => sum + (b.systematicBias === 'optimistic' ? b.calibrationError : b.systematicBias === 'pessimistic' ? -b.calibrationError : 0), 0) / buckets.length
      : 0;

    const riskAlertQuality = this.computeRiskAlertQuality(reports, T);

    const recommendations: string[] = [];
    const optimisticBuckets = buckets.filter(b => b.systematicBias === 'optimistic' && b.calibrationError > 10);
    if (optimisticBuckets.length > 0) {
      recommendations.push(`评分区间 ${optimisticBuckets.map(b => b.scoreRange).join('/')} 严重偏乐观，建议prompt中增加谨慎修正`);
    }
    if (riskAlertQuality.missedRate > 0.25) {
      recommendations.push(`漏报率 ${Math.round(riskAlertQuality.missedRate * 100)}%，建议增强反驳Agent强度`);
    }
    if (recommendations.length === 0) {
      recommendations.push('校准状态良好，继续保持');
    }

    return {
      period: { days, ...dateRange },
      totalReports: reports.length,
      validReports: totalValid,
      buckets,
      overallBias,
      riskAlertQuality,
      recommendations,
    };
  }

  /** 计算量化评分校准报告（使用 quant_score 而非 overall_score） */
  computeQuantCalibration(days: number, T: number = 5): CalibrationReport {
    const reports = this.eligibleReports(days);
    const dateRange = reports.length > 0
      ? { from: reports[reports.length - 1].date, to: reports[0].date }
      : { from: 'N/A', to: 'N/A' };

    // Filter to reports with quant scores
    const reportsWithQuant = reports.filter(r => r.quantScore !== null);
    const buckets: CalibrationBucket[] = [];
    let totalValid = 0;

    for (const { range, min, max } of SCORE_BUCKETS) {
      const isLast = max === 100;
      const matching = reportsWithQuant.filter(r => (r.quantScore ?? 0) >= min && (isLast ? (r.quantScore ?? 0) <= max : (r.quantScore ?? 0) < max));
      if (matching.length === 0) continue;

      let upCount = 0;
      let totalReturn = 0;
      let validCount = 0;

      for (const report of matching) {
        const currentPrice = this.prices.getByDate(report.date);
        const futurePrices = this.prices.getAfter(report.date, T).filter(p => validClose(p.londonClose));
        const futurePrice = futurePrices.length >= T ? futurePrices[T - 1] : null;

        if (!validClose(currentPrice?.londonClose) || !validClose(futurePrice?.londonClose)) continue;

        const futureReturn = (futurePrice.londonClose - currentPrice!.londonClose!) / currentPrice!.londonClose! * 100;
        if (futureReturn > 0) upCount++;
        totalReturn += futureReturn;
        validCount++;
      }

      if (validCount === 0) continue;
      totalValid += validCount;

      const avgReturn = totalReturn / validCount;
      const actualUpProbability = upCount / validCount;
      const midScore = (min + max) / 2;
      const calibrationError = Math.abs(midScore - actualUpProbability * 100);

      const predictedDirection: Direction = midScore > 50 ? 'bullish' : midScore < 50 ? 'bearish' : 'neutral';

      buckets.push({
        scoreRange: range,
        sampleSize: validCount,
        predictedDirection,
        actualUpCount: upCount,
        actualUpProbability,
        avgReturn,
        calibrationError,
        systematicBias: calibrationError < 5 ? 'calibrated'
          : midScore > actualUpProbability * 100 ? 'optimistic' : 'pessimistic',
      });
    }

    // 计算整体偏差
    const overallBias = buckets.length > 0
      ? buckets.reduce((sum, b) => sum + (b.systematicBias === 'optimistic' ? b.calibrationError : b.systematicBias === 'pessimistic' ? -b.calibrationError : 0), 0) / buckets.length
      : 0;

    // 计算风险预警质量
    const riskAlertQuality = this.computeRiskAlertQuality(reportsWithQuant as AnalysisReportRow[], T);

    // 生成建议
    const recommendations: string[] = [];
    const optimisticBuckets = buckets.filter(b => b.systematicBias === 'optimistic' && b.calibrationError > 10);
    if (optimisticBuckets.length > 0) {
      recommendations.push(`量化评分区间 ${optimisticBuckets.map(b => b.scoreRange).join('/')} 严重偏乐观，检查因子权重（勿抬 event_heat）`);
    }
    if (riskAlertQuality.missedRate > 0.25) {
      recommendations.push(`漏报率 ${Math.round(riskAlertQuality.missedRate * 100)}%，建议增强反驳Agent强度`);
    }
    if (recommendations.length === 0) {
      recommendations.push('量化评分校准状态良好，继续保持');
    }

    return {
      period: { days, ...dateRange },
      totalReports: reportsWithQuant.length,
      validReports: totalValid,
      buckets,
      overallBias,
      riskAlertQuality,
      recommendations,
    };
  }

  /** 计算风险预警质量 */
  private computeRiskAlertQuality(reports: AnalysisReportRow[], T: number): RiskAlertQuality {
    let redAlertCount = 0;
    let redAlertHitCount = 0;
    let missedAlerts = 0;
    let bigDropCount = 0;

    for (const report of reports) {
      const currentPrice = this.prices.getByDate(report.date);
      const futurePrices = this.prices.getAfter(report.date, T);
      const futurePrice = futurePrices.length >= T ? futurePrices[T - 1] : null;

      if (!currentPrice?.londonClose || !futurePrice?.londonClose) continue;

      const futureReturn = (futurePrice.londonClose - currentPrice.londonClose) / currentPrice.londonClose * 100;

      // 红灯 = direction=bearish 且 score<40
      const isRedAlert = report.direction === 'bearish' && report.overallScore < 40;
      const isBigDrop = futureReturn < -2;

      if (isRedAlert) {
        redAlertCount++;
        if (isBigDrop) redAlertHitCount++;
      }

      if (isBigDrop) {
        bigDropCount++;
        // 漏报 = 大跌但当日没亮红灯
        if (!isRedAlert && report.overallScore > 60 && report.direction !== 'bearish') {
          missedAlerts++;
        }
      }
    }

    return {
      redAlertCount,
      redAlertHitCount,
      redAlertHitRate: redAlertCount > 0 ? redAlertHitCount / redAlertCount : 0,
      missedAlerts,
      missedRate: bigDropCount > 0 ? missedAlerts / bigDropCount : 0,
    };
  }

  /** 获取校准上下文（全局 + 可选 regime 分桶） */
  getCalibrationContext(score: number, regimeTag?: string): import('../types/analysis.js').CalibrationContext | null {
    const matchedRange = scoreBucketRange(score);
    if (!matchedRange) return null;

    const reports = this.reports.getByScoreRange(matchedRange.min, matchedRange.max, 90);
    if (reports.length < 5) {
      return {
        scoreRange: matchedRange.range,
        historicalAccuracy: null,
        historicalAccuracy20d: null,
        systematicBias: '样本不足',
        sampleSize: reports.length,
        regimeTag,
        regimeHistoricalAccuracy: null,
        regimeSampleSize: 0,
        regimeSystematicBias: '样本不足',
      };
    }

    const acc5 = this.computeUpProbability(reports, 5);
    const acc20 = this.computeUpProbability(reports, 20);

    const midScore = (matchedRange.min + matchedRange.max) / 2;
    const bias = acc5.accuracy !== null
      ? (midScore > acc5.accuracy * 100 ? '偏乐观' : midScore < acc5.accuracy * 100 ? '偏保守' : '校准良好')
      : '未知';

    let regimeAcc: { accuracy: number | null; valid: number } = { accuracy: null, valid: 0 };
    let regimeBias = '样本不足';
    if (regimeTag) {
      const regimeReports = reports.filter(r => this.extractRegimeTag(r.reportJson) === regimeTag);
      regimeAcc = this.computeUpProbability(regimeReports, 5);
      if (regimeAcc.valid >= 3 && regimeAcc.accuracy != null) {
        regimeBias = midScore > regimeAcc.accuracy * 100
          ? '偏乐观'
          : midScore < regimeAcc.accuracy * 100
            ? '偏保守'
            : '校准良好';
      }
    }

    return {
      scoreRange: matchedRange.range,
      historicalAccuracy: acc5.accuracy,
      historicalAccuracy20d: acc20.accuracy,
      systematicBias: bias,
      sampleSize: acc5.valid,
      regimeTag,
      regimeHistoricalAccuracy: regimeAcc.accuracy,
      regimeSampleSize: regimeAcc.valid,
      regimeSystematicBias: regimeBias,
    };
  }

  private extractRegimeTag(reportJson: string): string | null {
    try {
      const r = JSON.parse(reportJson) as GoldAnalysisReport;
      return r.macroRegime?.tag ?? null;
    } catch {
      return null;
    }
  }

  /** 计算区间内报告在 T 日后的上涨概率 */
  private computeUpProbability(
    reports: AnalysisReportRow[],
    T: number,
  ): { accuracy: number | null; valid: number } {
    let upCount = 0;
    let valid = 0;
    for (const report of reports) {
      const currentPrice = this.prices.getByDate(report.date);
      const futurePrices = this.prices.getAfter(report.date, T);
      const futurePrice = futurePrices.length >= T ? futurePrices[T - 1] : null;
      if (!currentPrice?.londonClose || !futurePrice?.londonClose) continue;
      if (futurePrice.londonClose > currentPrice.londonClose) upCount++;
      valid++;
    }
    return {
      accuracy: valid > 0 ? upCount / valid : null,
      valid,
    };
  }
}
