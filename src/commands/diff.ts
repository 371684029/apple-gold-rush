// goldrush diff — 对比两日分析报告

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/index.js';
import { ReportsRepo } from '../db/reports.js';
import { diffReports, formatReportDiffConsole } from '../utils/report-diff.js';
import type { GoldAnalysisReport } from '../types/analysis.js';

function loadReportByDate(date: string): GoldAnalysisReport | null {
  const db = getDb();
  const row = new ReportsRepo(db).getByDate(date);
  if (row) {
    try {
      return JSON.parse(row.reportJson) as GoldAnalysisReport;
    } catch {
      return null;
    }
  }

  const jsonPath = path.resolve(process.cwd(), `goldrush-analysis-${date}.json`);
  if (fs.existsSync(jsonPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as GoldAnalysisReport | { report: GoldAnalysisReport };
      if ('report' in raw && raw.report) return raw.report;
      return raw as GoldAnalysisReport;
    } catch {
      return null;
    }
  }

  return null;
}

export function diffCommand(dateA: string, dateB: string, json: boolean): void {
  const reportA = loadReportByDate(dateA);
  const reportB = loadReportByDate(dateB);

  if (!reportA) {
    console.error(`❌ 未找到 ${dateA} 的报告（请先运行 analysis 或检查 SQLite）`);
    process.exit(1);
  }
  if (!reportB) {
    console.error(`❌ 未找到 ${dateB} 的报告（请先运行 analysis 或检查 SQLite）`);
    process.exit(1);
  }

  const diff = diffReports(dateA, dateB, reportA, reportB);

  if (json) {
    console.log(JSON.stringify(diff, null, 2));
  } else {
    console.log(formatReportDiffConsole(diff));
  }
}
