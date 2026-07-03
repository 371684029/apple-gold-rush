// 市场特征向量 CRUD
import Database from 'better-sqlite3';
import type { ScenarioFeature } from '../types/calibration.js';

export class ScenarioFeaturesRepo {
  constructor(private db: Database.Database) {}

  /** 插入特征向量 */
  insert(feature: Omit<ScenarioFeature, 'id' | 'createdAt' | 'actual5dReturn' | 'actual5dDirection' | 'actual20dReturn' | 'backfillStatus'>): number {
    const result = this.db.prepare(`
      INSERT INTO scenario_features (date, report_id, dollar_direction, dollar_magnitude,
        tips_direction, tips_magnitude, gold_deviation, vix_level,
        fed_stance, geopolitical_risk, momentum_direction, consecutive_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      feature.date, feature.reportId,
      feature.dollarDirection, feature.dollarMagnitude,
      feature.tipsDirection, feature.tipsMagnitude,
      feature.goldDeviation, feature.vixLevel,
      feature.fedStance, feature.geopoliticalRisk,
      feature.momentumDirection, feature.consecutiveDays
    );
    return Number(result.lastInsertRowid);
  }

  /** 获取待回填的记录 */
  getPendingBackfill(): ScenarioFeature[] {
    const rows = this.db.prepare(`
      SELECT sf.* FROM scenario_features sf
      JOIN analysis_reports ar ON sf.report_id = ar.id
      WHERE sf.backfill_status = 'pending'
      AND date(ar.date, '+5 days') <= date('now')
    `).all() as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  /** 回填实际收益 */
  backfill(id: number, return5d: number, direction5d: 'up' | 'down' | 'flat', return20d: number | null): void {
    this.db.prepare(`
      UPDATE scenario_features
      SET actual_5d_return = ?, actual_5d_direction = ?,
          actual_20d_return = ?, backfill_status = 'filled'
      WHERE id = ?
    `).run(return5d, direction5d, return20d, id);
  }

  /** 获取最近 N 天的特征 */
  getRecent(days: number): ScenarioFeature[] {
    const rows = this.db.prepare(`
      SELECT * FROM scenario_features
      WHERE date >= date('now', '-' || ? || ' days')
      ORDER BY date ASC
    `).all(days) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  /** 获取指定日期的特征 */
  getByDate(date: string): ScenarioFeature | undefined {
    const row = this.db.prepare(`SELECT * FROM scenario_features WHERE date = ? ORDER BY id DESC LIMIT 1`).get(date) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** 获取用于相似度匹配的历史特征（优先已回填） */
  listForSimilarity(maxRows = 200): ScenarioFeature[] {
    const rows = this.db.prepare(`
      SELECT * FROM scenario_features
      ORDER BY date DESC
      LIMIT ?
    `).all(maxRows) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  /** 获取指定报告的特征 */
  getByReportId(reportId: number): ScenarioFeature | undefined {
    const row = this.db.prepare(`SELECT * FROM scenario_features WHERE report_id = ?`).get(reportId) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : undefined;
  }
}

function mapRow(row: Record<string, unknown>): ScenarioFeature {
  return {
    id: row.id as number,
    date: row.date as string,
    reportId: row.report_id as number,
    dollarDirection: row.dollar_direction as 'up' | 'down' | 'flat',
    dollarMagnitude: row.dollar_magnitude as number,
    tipsDirection: row.tips_direction as 'up' | 'down' | 'flat',
    tipsMagnitude: row.tips_magnitude as number,
    goldDeviation: row.gold_deviation as number,
    vixLevel: row.vix_level as number,
    fedStance: row.fed_stance as 'hawkish' | 'dovish' | 'neutral',
    geopoliticalRisk: row.geopolitical_risk as 'high' | 'medium' | 'low',
    momentumDirection: row.momentum_direction as 'up' | 'down' | 'flat',
    consecutiveDays: row.consecutive_days as number,
    actual5dReturn: row.actual_5d_return as number | null,
    actual5dDirection: row.actual_5d_direction as 'up' | 'down' | 'flat' | null,
    actual20dReturn: row.actual_20d_return as number | null,
    backfillStatus: row.backfill_status as 'pending' | 'filled',
    createdAt: row.created_at as string,
  };
}
