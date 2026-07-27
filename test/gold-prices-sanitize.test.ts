import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { GoldPricesRepo } from '../src/db/gold-prices.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE gold_prices (
      date TEXT PRIMARY KEY,
      london_close REAL,
      london_high REAL,
      london_low REAL,
      shanghai_close REAL,
      shanghai_high REAL,
      shanghai_low REAL,
      etf_nav REAL,
      etf_change REAL,
      dollar_index REAL,
      us10y_yield REAL,
      tips_yield REAL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  return db;
}

describe('GoldPricesRepo.upsertBackfill sanitize', () => {
  let db: Database.Database;
  let repo: GoldPricesRepo;

  beforeEach(() => {
    db = makeDb();
    repo = new GoldPricesRepo(db);
  });

  it('首次回填 0/无效价不入库为 0', () => {
    repo.upsertBackfill({
      date: '2026-07-01',
      londonClose: 0,
      londonHigh: -1,
      londonLow: null,
      shanghaiClose: 0,
      shanghaiHigh: null,
      shanghaiLow: null,
      etfNav: 0,
      etfChange: null,
      dollarIndex: 0,
      us10yYield: 0,
      tipsYield: 0,
    });
    // 直接查库：sanitize 应写 NULL，而不是先写入 0 再靠 mapRow 掩盖
    const raw = db.prepare('SELECT london_close, dollar_index, tips_yield FROM gold_prices WHERE date = ?')
      .get('2026-07-01') as { london_close: number | null; dollar_index: number | null; tips_yield: number | null };
    expect(raw.london_close).toBeNull();
    expect(raw.dollar_index).toBeNull();
    expect(raw.tips_yield).toBeNull();
  });

  it('不覆盖已有有效列，只填 NULL', () => {
    repo.upsert({
      date: '2026-07-02',
      londonClose: 4100,
      londonHigh: null,
      londonLow: null,
      shanghaiClose: null,
      shanghaiHigh: null,
      shanghaiLow: null,
      etfNav: null,
      etfChange: null,
      dollarIndex: 104,
      us10yYield: null,
      tipsYield: null,
    });
    repo.upsertBackfill({
      date: '2026-07-02',
      londonClose: 1,
      londonHigh: null,
      londonLow: null,
      shanghaiClose: null,
      shanghaiHigh: null,
      shanghaiLow: null,
      etfNav: null,
      etfChange: null,
      dollarIndex: 99,
      us10yYield: 4.2,
      tipsYield: 1.5,
    });
    const row = repo.getByDate('2026-07-02');
    expect(row?.londonClose).toBe(4100);
    expect(row?.dollarIndex).toBe(104);
    expect(row?.us10yYield).toBe(4.2);
    expect(row?.tipsYield).toBe(1.5);
  });
});
