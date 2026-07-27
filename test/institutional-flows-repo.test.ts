import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { InstitutionalFlowsRepo } from '../src/db/institutional-flows.js';
import type { InstitutionalFlowRecord } from '../src/types/institutional.js';

type Row = Omit<InstitutionalFlowRecord, 'createdAt'>;

function emptyRow(date: string): Row {
  return {
    date,
    cftcNcLong: null, cftcNcShort: null, cftcNcNet: null, cftcNcChange: null,
    cftcCommNet: null, cftcOpenInterest: null, cftcReportDate: null,
    gldHoldingsTons: null, gldHoldingsChange: null, gldAumMillion: null,
    iauHoldingsTons: null,
    cnEtf518880Shares: null, cnEtf518880Flow: null,
    cnEtf159934Shares: null, cnEtf159934Flow: null,
    cbPbocReserves: null, cbPbocChange: null,
    comexVolume: null,
  };
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE institutional_flows (
      date TEXT PRIMARY KEY,
      cftc_nc_long REAL, cftc_nc_short REAL, cftc_nc_net REAL, cftc_nc_change REAL,
      cftc_comm_net REAL, cftc_open_interest REAL, cftc_report_date TEXT,
      gld_holdings_tons REAL, gld_holdings_change REAL, gld_aum_million REAL,
      iau_holdings_tons REAL,
      cn_etf_518880_shares REAL, cn_etf_518880_flow REAL,
      cn_etf_159934_shares REAL, cn_etf_159934_flow REAL,
      cb_pboc_reserves REAL, cb_pboc_change REAL,
      comex_volume REAL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  return db;
}

describe('InstitutionalFlowsRepo.upsert 不互相清空', () => {
  let db: Database.Database;
  let repo: InstitutionalFlowsRepo;

  beforeEach(() => {
    db = makeDb();
    repo = new InstitutionalFlowsRepo(db);
  });

  it('刷新 CFTC 不会清掉同一天已抓到的 GLD 吨数与央行储备', () => {
    // ensureGld 先写入 ETF 与央行数据
    repo.upsert({ ...emptyRow('2026-07-20'), gldHoldingsTons: 880.5, cbPbocReserves: 2280 });
    // ensureCftc 随后写入 CFTC，GLD/PBOC 位置显式传 null
    repo.upsert({
      ...emptyRow('2026-07-20'),
      cftcNcLong: 250000, cftcNcShort: 60000, cftcNcNet: 190000,
      cftcReportDate: '2026-07-15',
    });

    const row = repo.getByDate('2026-07-20')!;
    expect(row.cftcNcNet).toBe(190000);
    expect(row.gldHoldingsTons).toBe(880.5);
    expect(row.cbPbocReserves).toBe(2280);
  });

  it('反向顺序同样不丢数据', () => {
    repo.upsert({ ...emptyRow('2026-07-20'), cftcNcNet: 190000 });
    repo.upsert({ ...emptyRow('2026-07-20'), gldHoldingsTons: 880.5 });

    const row = repo.getByDate('2026-07-20')!;
    expect(row.cftcNcNet).toBe(190000);
    expect(row.gldHoldingsTons).toBe(880.5);
  });

  it('有新值时正常覆盖旧值', () => {
    repo.upsert({ ...emptyRow('2026-07-20'), gldHoldingsTons: 880.5 });
    repo.upsert({ ...emptyRow('2026-07-20'), gldHoldingsTons: 875.1 });
    expect(repo.getByDate('2026-07-20')!.gldHoldingsTons).toBe(875.1);
  });

  it('多来源分次写入后各字段齐备', () => {
    repo.upsert({ ...emptyRow('2026-07-20'), cftcNcNet: 190000 });
    repo.upsert({ ...emptyRow('2026-07-20'), gldHoldingsTons: 880.5 });
    repo.upsert({ ...emptyRow('2026-07-20'), cbPbocReserves: 2280 });
    repo.upsert({ ...emptyRow('2026-07-20'), comexVolume: 123456 });

    const row = repo.getByDate('2026-07-20')!;
    expect(row.cftcNcNet).toBe(190000);
    expect(row.gldHoldingsTons).toBe(880.5);
    expect(row.cbPbocReserves).toBe(2280);
    expect(row.comexVolume).toBe(123456);
  });
});
