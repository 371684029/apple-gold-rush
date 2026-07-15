// 确保主力数据可用 — flow / analysis 前自动补齐

import { todayDate } from './time.js';
import type { InstitutionalFlowsRepo } from '../db/institutional-flows.js';
import { fetchCftcHistory } from '../data/cftc-grabber.js';
import { fetchGldHoldings } from '../data/etf-grabber.js';
import { fetchLatestPbocReserve } from '../data/pboc-grabber.js';

export interface EnsureFlowsResult {
  cftc: { fetched: boolean; records: number; error?: string };
  gld: { fetched: boolean; records: number; error?: string };
  pboc: { fetched: boolean; records: number; error?: string };
  totalRows: number;
}

/**
 * 检查是否需要更新 CFTC 数据。
 * CFTC 每周五公布截至周二的报告。
 * 如果最新 DB 记录的报告日期距今超过 7 天，尝试拉取。
 */
async function ensureCftc(repo: InstitutionalFlowsRepo): Promise<EnsureFlowsResult['cftc']> {
  const latest = repo.getLatestCftc();
  const today = new Date();

  // 如果 DB 中有 CFTC 数据，判断是否过期
  if (latest?.cftcReportDate) {
    const lastDate = new Date(latest.cftcReportDate);
    const daysSinceLast = Math.floor((today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSinceLast < 7) {
      return { fetched: false, records: 0 };
    }
  }

  // 尝试拉取最新数据
  try {
    const currentYear = today.getFullYear();
    const records = await fetchCftcHistory(currentYear);
    if (records.length === 0) {
      return { fetched: false, records: 0, error: 'CFTC 数据为空，可能网络异常或年度文件未发布' };
    }

    let saved = 0;
    for (const r of records) {
      // 只 upsert 比 DB 中更新的记录（避免重复写入）
      if (latest && r.date <= (latest.cftcReportDate ?? '')) continue;
      repo.upsert({
        date: r.date,
        cftcNcLong: r.nonCommLong,
        cftcNcShort: r.nonCommShort,
        cftcNcNet: r.nonCommNet,
        cftcNcChange: r.nonCommNetChange,
        cftcCommNet: r.commNet,
        cftcOpenInterest: r.openInterest,
        cftcReportDate: r.date,
        gldHoldingsTons: null,
        gldHoldingsChange: null,
        gldAumMillion: null,
        iauHoldingsTons: null,
        cnEtf518880Shares: null,
        cnEtf518880Flow: null,
        cnEtf159934Shares: null,
        cnEtf159934Flow: null,
        cbPbocReserves: null,
        cbPbocChange: null,
        comexVolume: null,
      });
      saved++;
    }
    return { fetched: true, records: saved };
  } catch (err) {
    return { fetched: false, records: 0, error: String(err) };
  }
}

/**
 * 检查是否需要更新 GLD ETF 数据。
 * 最新 DB 记录日期不是昨天 → 尝试拉取。
 */
async function ensureGld(repo: InstitutionalFlowsRepo): Promise<EnsureFlowsResult['gld']> {
  const recent = repo.getRecent(2);
  const today = todayDate();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  // 有「今天或昨天」的 GLD 且总有效点数≥5 则跳过；否则继续回填新闻历史
  const gldCount = recent.filter(r => r.gldHoldingsTons != null && r.gldHoldingsTons > 0).length;
  const hasRecent = recent.some(r => r.date >= yesterdayStr && r.gldHoldingsTons != null);
  if (hasRecent && gldCount >= 5) {
    return { fetched: false, records: 0 };
  }

  try {
    const holdings = await fetchGldHoldings();
    if (holdings.length === 0) {
      return { fetched: false, records: 0, error: 'GLD 数据为空' };
    }

    let saved = 0;
    for (const h of holdings) {
      const existing = repo.getByDate(h.date);
      // 已有有效吨数则跳过，避免覆盖
      if (existing?.gldHoldingsTons != null && existing.gldHoldingsTons > 0) continue;
      repo.upsert({
        date: h.date,
        cftcNcLong: existing?.cftcNcLong ?? null,
        cftcNcShort: existing?.cftcNcShort ?? null,
        cftcNcNet: existing?.cftcNcNet ?? null,
        cftcNcChange: existing?.cftcNcChange ?? null,
        cftcCommNet: existing?.cftcCommNet ?? null,
        cftcOpenInterest: existing?.cftcOpenInterest ?? null,
        cftcReportDate: existing?.cftcReportDate ?? null,
        gldHoldingsTons: h.gldTons,
        gldHoldingsChange: h.gldChange,
        gldAumMillion: h.gldAum,
        iauHoldingsTons: h.iauTons ?? null,
        cnEtf518880Shares: existing?.cnEtf518880Shares ?? null,
        cnEtf518880Flow: existing?.cnEtf518880Flow ?? null,
        cnEtf159934Shares: existing?.cnEtf159934Shares ?? null,
        cnEtf159934Flow: existing?.cnEtf159934Flow ?? null,
        cbPbocReserves: existing?.cbPbocReserves ?? null,
        cbPbocChange: existing?.cbPbocChange ?? null,
        comexVolume: existing?.comexVolume ?? null,
      });
      saved++;
    }
    return { fetched: true, records: saved };
  } catch (err) {
    return { fetched: false, records: 0, error: String(err) };
  }
}

async function ensurePboc(repo: InstitutionalFlowsRepo): Promise<EnsureFlowsResult['pboc']> {
  const recent = repo.getRecent(40);
  const hasPboc = recent.some(r => r.cbPbocReserves != null && r.cbPbocReserves > 0);
  // 月度数据：有记录且 25 天内更新过则跳过
  if (hasPboc) {
    const last = [...recent].reverse().find(r => r.cbPbocReserves != null);
    if (last) {
      const days = Math.floor((Date.now() - Date.parse(last.date)) / 86_400_000);
      if (days < 25) return { fetched: false, records: 0 };
    }
  }

  try {
    const rec = await fetchLatestPbocReserve();
    if (!rec) return { fetched: false, records: 0, error: 'PBOC 储备未能从公开源解析' };

    const existing = repo.getByDate(rec.date);
    const prev = [...recent].reverse().find(r => r.cbPbocReserves != null && r.date !== rec.date);
    const change = prev?.cbPbocReserves != null
      ? Math.round((rec.pbocReserves - prev.cbPbocReserves) * 10) / 10
      : rec.pbocChange;

    repo.upsert({
      date: rec.date,
      cftcNcLong: existing?.cftcNcLong ?? null,
      cftcNcShort: existing?.cftcNcShort ?? null,
      cftcNcNet: existing?.cftcNcNet ?? null,
      cftcNcChange: existing?.cftcNcChange ?? null,
      cftcCommNet: existing?.cftcCommNet ?? null,
      cftcOpenInterest: existing?.cftcOpenInterest ?? null,
      cftcReportDate: existing?.cftcReportDate ?? null,
      gldHoldingsTons: existing?.gldHoldingsTons ?? null,
      gldHoldingsChange: existing?.gldHoldingsChange ?? null,
      gldAumMillion: existing?.gldAumMillion ?? null,
      iauHoldingsTons: existing?.iauHoldingsTons ?? null,
      cnEtf518880Shares: existing?.cnEtf518880Shares ?? null,
      cnEtf518880Flow: existing?.cnEtf518880Flow ?? null,
      cnEtf159934Shares: existing?.cnEtf159934Shares ?? null,
      cnEtf159934Flow: existing?.cnEtf159934Flow ?? null,
      cbPbocReserves: rec.pbocReserves,
      cbPbocChange: change,
      comexVolume: existing?.comexVolume ?? null,
    });
    return { fetched: true, records: 1 };
  } catch (err) {
    return { fetched: false, records: 0, error: String(err) };
  }
}

/**
 * 自动补齐主力数据（CFTC + GLD ETF + PBOC）。
 * 幂等：已有最新数据时跳过网络请求。
 */
export async function ensureInstitutionalFlows(repo: InstitutionalFlowsRepo): Promise<EnsureFlowsResult> {
  const [cftc, gld, pboc] = await Promise.all([
    ensureCftc(repo),
    ensureGld(repo),
    ensurePboc(repo),
  ]);

  return {
    cftc,
    gld,
    pboc,
    totalRows: repo.count(),
  };
}
