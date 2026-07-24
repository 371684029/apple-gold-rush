// 历史预测对错统计 — 基于 analysis_reports + gold_prices
//
// 写入 docs/goldrush-stats-latest.json 供 Web 展示；日报 MD 嵌入摘要表

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { ReportsRepo } from '../db/reports.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import { CalibrationRepo } from '../db/calibration.js';
import { SCORE_BUCKETS } from './score-buckets.js';
import {
  DUAL_CONFLICT_THRESHOLD,
  predictDirectionFromScore,
} from './dual-score.js';

export interface PredictionRecentRow {
  date: string;
  llmScore: number;
  quantScore: number | null;
  direction: string;
  pred: 'up' | 'down' | 'flat';
  actual5dPct: number | null;
  hit: boolean | null; // null = 未回填/持平不计
  status: 'hit' | 'miss' | 'pending' | 'flat';
  /**
   * 顺预测幅度（%）：预测涨则取实际涨幅；预测跌则取 -实际涨幅。
   * 正=价格朝预测方向走；负=逆预测。持平/待回填为 null。
   */
  alignPct: number | null;
  /** 同评分区间历史 5 日均涨幅（%），用于「相对同档偏差」 */
  bucketAvgReturn: number | null;
  /** 本日实际 − 同档均值（百分点） */
  vsBucketPct: number | null;
  /** 量化方向预测（有 quant_score 时） */
  quantPred: 'up' | 'down' | 'flat' | null;
  quantHit: boolean | null;
  quantStatus: 'hit' | 'miss' | 'pending' | 'flat' | null;
}

export interface PredictionBucketStat {
  range: string;
  sample: number;
  upRate: number; // 0-100
  avgReturn: number;
}

export interface PredictionTrackStats {
  asOf: string;
  windowDays: number;
  sampleEligible: number;
  llm: { hits: number; total: number; hitRate: number | null };
  quant: { hits: number; total: number; hitRate: number | null };
  /** 高分段(≥60) 实际 5 日涨概率 */
  highScoreUpRate: number | null;
  highScoreN: number;
  /** 低分段(≤40) 实际 5 日涨概率 */
  lowScoreUpRate: number | null;
  lowScoreN: number;
  conflictDays: number;
  conflictFollowQuantHits: number;
  conflictFollowLlmHits: number;
  buckets: PredictionBucketStat[];
  recent: PredictionRecentRow[];
  summary: string;
}

function validClose(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v) && v > 0;
}

function futureReturn(
  prices: GoldPricesRepo,
  date: string,
  T: number,
): number | null {
  const cur = prices.getByDate(date);
  if (!validClose(cur?.londonClose)) return null;
  const after = prices.getAfter(date, T).filter(p => validClose(p.londonClose));
  if (after.length < Math.min(T, 3)) return null;
  const fut = after.length >= T ? after[T - 1] : after[after.length - 1];
  if (!validClose(fut.londonClose)) return null;
  return ((fut.londonClose - cur!.londonClose!) / cur!.londonClose!) * 100;
}

export function buildPredictionTrackStats(
  db: Database.Database,
  windowDays = 90,
  T = 5,
): PredictionTrackStats {
  const reports = new ReportsRepo(db);
  const prices = new GoldPricesRepo(db);
  const cal = new CalibrationRepo(db);

  // 复用已有双重命中统计（已排除红档/无效价）
  const dual = cal.computeDualTrackHitStats(windowDays, T);
  const llmHitRate = dual.llmTotal > 0 ? dual.llmHits / dual.llmTotal : null;
  const quantHitRate = dual.quantTotal > 0 ? dual.quantHits / dual.quantTotal : null;

  // 分桶（LLM）
  const eligible = reports.getRecent(windowDays).filter(r => {
    const p = prices.getByDate(r.date);
    return validClose(p?.londonClose);
  });

  const buckets: PredictionBucketStat[] = [];
  for (const { range, min, max } of SCORE_BUCKETS) {
    const isLast = max === 100;
    const matching = eligible.filter(r =>
      r.overallScore >= min && (isLast ? r.overallScore <= max : r.overallScore < max),
    );
    let up = 0;
    let sum = 0;
    let n = 0;
    for (const r of matching) {
      const ret = futureReturn(prices, r.date, T);
      if (ret == null) continue;
      n++;
      sum += ret;
      if (ret > 0) up++;
    }
    if (n === 0) continue;
    buckets.push({
      range,
      sample: n,
      upRate: Math.round((up / n) * 1000) / 10,
      avgReturn: Math.round((sum / n) * 100) / 100,
    });
  }

  // 高/低分段涨概率
  let highUp = 0, highN = 0, lowUp = 0, lowN = 0;
  for (const r of eligible) {
    const ret = futureReturn(prices, r.date, T);
    if (ret == null) continue;
    if (r.overallScore >= 60) {
      highN++;
      if (ret > 0) highUp++;
    }
    if (r.overallScore <= 40) {
      lowN++;
      if (ret > 0) lowUp++;
    }
  }

  // 全窗明细（供 Web 列表按日挂对错；MD/控制台仍只展示近若干条）
  const bucketAvgByRange = new Map(buckets.map(b => [b.range, b.avgReturn]));
  const recent: PredictionRecentRow[] = [];
  for (const r of eligible) {
    const ret = futureReturn(prices, r.date, T);
    const predDir = predictDirectionFromScore(r.overallScore);
    let pred: PredictionRecentRow['pred'] = 'flat';
    if (predDir === 'up') pred = 'up';
    else if (predDir === 'down') pred = 'down';

    let status: PredictionRecentRow['status'] = 'pending';
    let hit: boolean | null = null;
    if (ret == null) {
      status = 'pending';
    } else if (Math.abs(ret) <= 0.1 || pred === 'flat') {
      status = 'flat';
      hit = null;
    } else {
      const actualUp = ret > 0.1;
      const actualDown = ret < -0.1;
      hit = (pred === 'up' && actualUp) || (pred === 'down' && actualDown);
      status = hit ? 'hit' : 'miss';
    }

    let alignPct: number | null = null;
    if (ret != null && pred === 'up') alignPct = Math.round(ret * 100) / 100;
    else if (ret != null && pred === 'down') alignPct = Math.round((-ret) * 100) / 100;

    const bucketRange = SCORE_BUCKETS.find(({ min, max }) => {
      const isLast = max === 100;
      return r.overallScore >= min && (isLast ? r.overallScore <= max : r.overallScore < max);
    })?.range ?? null;
    const bucketAvgReturn = bucketRange != null
      ? (bucketAvgByRange.get(bucketRange) ?? null)
      : null;
    const vsBucketPct = ret != null && bucketAvgReturn != null
      ? Math.round((ret - bucketAvgReturn) * 100) / 100
      : null;

    let quantPred: PredictionRecentRow['quantPred'] = null;
    let quantHit: boolean | null = null;
    let quantStatus: PredictionRecentRow['quantStatus'] = null;
    if (r.quantScore != null) {
      const qDir = predictDirectionFromScore(r.quantScore);
      quantPred = qDir === 'up' ? 'up' : qDir === 'down' ? 'down' : 'flat';
      if (ret == null) {
        quantStatus = 'pending';
      } else if (Math.abs(ret) <= 0.1 || quantPred === 'flat') {
        quantStatus = 'flat';
        quantHit = null;
      } else {
        const actualUp = ret > 0.1;
        const actualDown = ret < -0.1;
        quantHit = (quantPred === 'up' && actualUp) || (quantPred === 'down' && actualDown);
        quantStatus = quantHit ? 'hit' : 'miss';
      }
    }

    recent.push({
      date: r.date,
      llmScore: r.overallScore,
      quantScore: r.quantScore,
      direction: r.direction,
      pred,
      actual5dPct: ret != null ? Math.round(ret * 100) / 100 : null,
      hit,
      status,
      alignPct,
      bucketAvgReturn,
      vsBucketPct,
      quantPred,
      quantHit,
      quantStatus,
    });
  }

  const parts: string[] = [];
  if (llmHitRate != null) {
    parts.push(`LLM 方向命中 ${(llmHitRate * 100).toFixed(0)}%（${dual.llmHits}/${dual.llmTotal}）`);
  } else {
    parts.push('LLM 方向样本不足');
  }
  if (quantHitRate != null) {
    parts.push(`量化命中 ${(quantHitRate * 100).toFixed(0)}%（${dual.quantHits}/${dual.quantTotal}）`);
  } else {
    parts.push('量化样本待积累');
  }
  if (highN >= 3) {
    parts.push(`高分段(≥60) 5日涨 ${(highUp / highN * 100).toFixed(0)}%`);
  }
  if (lowN >= 3) {
    parts.push(`低分段(≤40) 5日涨 ${(lowUp / lowN * 100).toFixed(0)}%`);
  }
  if (dual.conflictDays > 0) {
    parts.push(`冲突日 ${dual.conflictDays}（跟量化 ${dual.conflictFollowQuantHits} / 跟LLM ${dual.conflictFollowLlmHits}）`);
  }

  return {
    asOf: new Date().toISOString().slice(0, 10),
    windowDays,
    sampleEligible: eligible.length,
    llm: {
      hits: dual.llmHits,
      total: dual.llmTotal,
      hitRate: llmHitRate != null ? Math.round(llmHitRate * 1000) / 10 : null,
    },
    quant: {
      hits: dual.quantHits,
      total: dual.quantTotal,
      hitRate: quantHitRate != null ? Math.round(quantHitRate * 1000) / 10 : null,
    },
    highScoreUpRate: highN >= 1 ? Math.round((highUp / highN) * 1000) / 10 : null,
    highScoreN: highN,
    lowScoreUpRate: lowN >= 1 ? Math.round((lowUp / lowN) * 1000) / 10 : null,
    lowScoreN: lowN,
    conflictDays: dual.conflictDays,
    conflictFollowQuantHits: dual.conflictFollowQuantHits,
    conflictFollowLlmHits: dual.conflictFollowLlmHits,
    buckets,
    recent,
    summary: parts.join(' · '),
  };
}

/** 写入 docs/ 供 Web 直接读取 */
export function savePredictionTrackJson(
  stats: PredictionTrackStats,
  projectRoot: string = process.cwd(),
): string {
  const docsDir = path.join(projectRoot, 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
  const out = path.join(docsDir, 'goldrush-stats-latest.json');
  fs.writeFileSync(out, JSON.stringify(stats, null, 2), 'utf-8');
  return out;
}

export function formatPredictionTrackConsole(stats: PredictionTrackStats, indent = '  '): string {
  const lines = [
    `${indent}📊 历史预测对错（近 ${stats.windowDays} 日 · 5 日标签）`,
    `${indent}  ${stats.summary}`,
    `${indent}  样本报告 ${stats.sampleEligible} 条`,
  ];
  if (stats.recent.length) {
    lines.push(`${indent}  近况：`);
    for (const r of stats.recent.slice(0, 8)) {
      const mark = r.status === 'hit' ? '✅' : r.status === 'miss' ? '❌' : r.status === 'flat' ? '➖' : '⏳';
      const ret = r.actual5dPct != null ? `${r.actual5dPct > 0 ? '+' : ''}${r.actual5dPct}%` : '待回填';
      const align = r.alignPct != null
        ? (r.alignPct >= 0 ? `顺+${r.alignPct}%` : `逆${r.alignPct}%`)
        : '';
      lines.push(`${indent}    ${mark} ${r.date} LLM=${r.llmScore} 预测=${r.pred} 5日=${ret}${align ? ` ${align}` : ''}`);
    }
  }
  return lines.join('\n');
}

export function formatPredictionTrackMarkdown(stats: PredictionTrackStats): string {
  const lines = [
    '## 📊 历史预测对错',
    '',
    `> 窗口近 **${stats.windowDays}** 日 · 标签：**5 个交易日**涨跌 · 样本 **${stats.sampleEligible}** 条 · 统计日 ${stats.asOf}`,
    '',
    stats.summary,
    '',
    '### 关键统计',
    '',
    '| 指标 | 数值 |',
    '|------|------|',
    `| LLM 方向命中 | ${stats.llm.hitRate != null ? `**${stats.llm.hitRate}%**（${stats.llm.hits}/${stats.llm.total}）` : 'N/A'} |`,
    `| 量化方向命中 | ${stats.quant.hitRate != null ? `**${stats.quant.hitRate}%**（${stats.quant.hits}/${stats.quant.total}）` : 'N/A（待积累 quant_score）'} |`,
    `| 高分段(≥60) 5日涨概率 | ${stats.highScoreUpRate != null ? `**${stats.highScoreUpRate}%**（n=${stats.highScoreN}）` : 'N/A'} |`,
    `| 低分段(≤40) 5日涨概率 | ${stats.lowScoreUpRate != null ? `**${stats.lowScoreUpRate}%**（n=${stats.lowScoreN}）` : 'N/A'} |`,
    `| 双分冲突日 | **${stats.conflictDays}**（跟量化对 ${stats.conflictFollowQuantHits} / 跟LLM对 ${stats.conflictFollowLlmHits}） |`,
    '',
  ];

  if (stats.buckets.length) {
    lines.push('### 评分区间 vs 实际 5 日');
    lines.push('');
    lines.push('| 评分区间 | 样本 | 实际涨概率 | 平均涨幅 |');
    lines.push('|----------|------|------------|----------|');
    for (const b of stats.buckets) {
      lines.push(`| ${b.range} | ${b.sample} | ${b.upRate}% | ${b.avgReturn > 0 ? '+' : ''}${b.avgReturn}% |`);
    }
    lines.push('');
  }

  if (stats.recent.length) {
    lines.push('### 最近预测明细');
    lines.push('');
    lines.push('| 日期 | LLM | 量化 | 预测 | 5日涨跌 | 对错 | 顺/逆预测 | 相对同档 |');
    lines.push('|------|-----|------|------|---------|------|-----------|----------|');
    for (const r of stats.recent.slice(0, 12)) {
      const mark = r.status === 'hit' ? '✅' : r.status === 'miss' ? '❌' : r.status === 'flat' ? '➖' : '⏳';
      const ret = r.actual5dPct != null ? `${r.actual5dPct > 0 ? '+' : ''}${r.actual5dPct}%` : '—';
      const q = r.quantScore != null ? String(r.quantScore) : '—';
      const align = r.alignPct == null ? '—'
        : r.alignPct >= 0 ? `顺 +${r.alignPct}%` : `逆 ${Math.abs(r.alignPct)}%`;
      const vs = r.vsBucketPct == null ? '—'
        : `${r.vsBucketPct > 0 ? '+' : ''}${r.vsBucketPct}%`;
      lines.push(`| ${r.date} | ${r.llmScore} | ${q} | ${r.pred} | ${ret} | ${mark} | ${align} | ${vs} |`);
    }
    lines.push('');
  }

  lines.push('> 预测方向：分数 &gt;55 记「涨」，&lt;45 记「跌」，中间不计入命中率；持平(|涨跌|≤0.1%) 不计对错。**顺/逆预测**：价格是否朝预测方向走；**相对同档**：本日 5 日涨跌 − 同评分区间历史均值。非投资业绩承诺。');
  lines.push('');
  return lines.join('\n');
}
