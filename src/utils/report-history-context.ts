// 近期报告上下文 — 注入编排 prompt，增强趋势连续性

import type { AnalysisReportRow } from '../db/reports.js';
import type { GoldAnalysisReport } from '../types/analysis.js';

function dirLabel(d: string): string {
  if (d === 'bullish') return '偏多';
  if (d === 'bearish') return '偏空';
  return '中性';
}

/** 从 SQLite 最近 N 份报告生成 prompt 片段（不含今日） */
export function buildRecentReportsContext(
  rows: AnalysisReportRow[],
  excludeDate: string,
  limit = 3,
): string {
  const filtered = rows
    .filter(r => r.date < excludeDate)
    .slice(0, limit);

  if (filtered.length === 0) {
    return '无历史报告可对比（首次运行或样本不足）。';
  }

  const lines: string[] = ['## 近期分析回顾（供趋势对比，勿机械重复）'];
  for (const row of filtered) {
    let summary = '';
    try {
      const report = JSON.parse(row.reportJson) as GoldAnalysisReport;
      summary = report.technical?.summary?.slice(0, 40) ?? '';
    } catch { /* ignore */ }
    lines.push(
      `- ${row.date}：综合 ${row.overallScore} 分（${dirLabel(row.direction)}）${summary ? `，技术：${summary}` : ''}`,
    );
  }

  const newest = filtered[0];
  const oldest = filtered[filtered.length - 1];
  if (filtered.length >= 2) {
    const delta = newest.overallScore - oldest.overallScore;
    const trend = delta > 5 ? '评分走高' : delta < -5 ? '评分走低' : '评分大致持平';
    lines.push(`- 区间变化：${oldest.date}→${newest.date} ${delta > 0 ? '+' : ''}${delta} 分（${trend}）`);
  }

  lines.push('- 输出时请简要说明与最近一次分析的异同（若有明显变化需点明驱动因素）。');
  return lines.join('\n');
}
