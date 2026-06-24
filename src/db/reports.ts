// 分析报告存档 CRUD
import Database from 'better-sqlite3';
import type { Direction } from '../types/analysis.js';

export interface AnalysisReportRow {
  id: number;
  date: string;
  horizon: string;
  reportJson: string;
  overallScore: number;
  direction: Direction;
  createdAt: string;
}

export class ReportsRepo {
  constructor(private db: Database.Database) {}

  /** 插入分析报告 */
  insert(report: Omit<AnalysisReportRow, 'id' | 'createdAt'>): number {
    const result = this.db.prepare(`
      INSERT INTO analysis_reports (date, horizon, report_json, overall_score, direction)
      VALUES (?, ?, ?, ?, ?)
    `).run(report.date, report.horizon, report.reportJson, report.overallScore, report.direction);
    return Number(result.lastInsertRowid);
  }

  /** 获取最近 N 天的报告 */
  getRecent(days: number): AnalysisReportRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM analysis_reports
      WHERE date >= date('now', '-' || ? || ' days')
      ORDER BY date DESC
    `).all(days) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  /**
   * 获取指定评分区间的报告。
   * 区间为左闭右开 [min, max)；当 max 为 100（最高区间）时右端取闭区间，
   * 使满分 100 的报告也能被纳入，与校准分桶逻辑保持一致。
   */
  getByScoreRange(minScore: number, maxScore: number, days?: number): AnalysisReportRow[] {
    const upperOp = maxScore >= 100 ? '<=' : '<';
    if (days) {
      const rows = this.db.prepare(`
        SELECT * FROM analysis_reports
        WHERE overall_score >= ? AND overall_score ${upperOp} ?
        AND date >= date('now', '-' || ? || ' days')
        ORDER BY date ASC
      `).all(minScore, maxScore, days) as Record<string, unknown>[];
      return rows.map(mapRow);
    }
    const rows = this.db.prepare(`
      SELECT * FROM analysis_reports
      WHERE overall_score >= ? AND overall_score ${upperOp} ?
      ORDER BY date ASC
    `).all(minScore, maxScore) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  /** 获取指定日期的报告 */
  getByDate(date: string): AnalysisReportRow | undefined {
    const row = this.db.prepare(`SELECT * FROM analysis_reports WHERE date = ?`).get(date) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** 获取总报告数 */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM analysis_reports`).get() as { cnt: number };
    return row.cnt;
  }
}

function mapRow(row: Record<string, unknown>): AnalysisReportRow {
  return {
    id: row.id as number,
    date: row.date as string,
    horizon: row.horizon as string,
    reportJson: row.report_json as string,
    overallScore: row.overall_score as number,
    direction: row.direction as Direction,
    createdAt: row.created_at as string,
  };
}
