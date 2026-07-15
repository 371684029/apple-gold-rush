// 主力动向信号计算 (CFTC / ETF / 央行购金) — 纯本地计算，无网络/LLM
import { percentile } from './percentile.js';
import { getDb } from '../db/index.js';
import { InstitutionalFlowsRepo } from '../db/institutional-flows.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import type {
  CftcSignal,
  EtfFlowSignal,
  CentralBankSignal,
  InstitutionalSignal,
  DivergenceSignal,
  Direction,
} from '../types/institutional.js';
import type { GoldPriceRecord } from '../types/market.js';
import type { InstitutionalFlowRecord } from '../types/institutional.js';

// ===== 内部数据类型（从 DB 记录投影） =====

interface CftcNetRecord {
  date: string;
  ncNet: number;
  ncChange: number;
  openInterest: number;
}

interface GldRecord {
  date: string;
  tons: number;
  change: number;
}

interface PbocRecord {
  date: string;
  reserves: number;
  change: number;
  consecutiveMonths: number;
}

// ===== 辅助函数 =====

/**
 * 将数值线性映射到 0-100 分。
 * 正值（高于阈值）= 看多，负值（低于阈值）= 看空，结果限制在 [10, 90]。
 */
function directionScore(value: number, threshold: number = 0): number {
  const score = 50 + (value - threshold) * 10;
  return Math.max(10, Math.min(90, Math.round(score)));
}

/** 将 InstitutionalFlowRecord[] 投影为 CftcNetRecord[]（仅保留 cftcNcNet 非空的记录） */
function toCftcNetRecords(records: InstitutionalFlowRecord[]): CftcNetRecord[] {
  const result: CftcNetRecord[] = [];
  for (const r of records) {
    if (r.cftcNcNet === null) continue;
    result.push({
      date: r.cftcReportDate ?? r.date,
      ncNet: r.cftcNcNet,
      ncChange: r.cftcNcChange ?? 0,
      openInterest: r.cftcOpenInterest ?? 0,
    });
  }
  return result;
}

/** 将 InstitutionalFlowRecord[] 投影为 GldRecord[]（仅保留 gldHoldingsTons 非空的记录） */
function toGldRecords(records: InstitutionalFlowRecord[]): GldRecord[] {
  const result: GldRecord[] = [];
  for (const r of records) {
    if (r.gldHoldingsTons === null) continue;
    result.push({
      date: r.date,
      tons: r.gldHoldingsTons,
      change: r.gldHoldingsChange ?? 0,
    });
  }
  return result;
}

/** 将 InstitutionalFlowRecord[] 投影为 PbocRecord[]（仅保留 cbPbocReserves 非空的记录） */
function toPbocRecords(records: InstitutionalFlowRecord[]): PbocRecord[] {
  const result: PbocRecord[] = [];
  for (const r of records) {
    if (r.cbPbocReserves === null) continue;
    result.push({
      date: r.date,
      reserves: r.cbPbocReserves,
      change: r.cbPbocChange ?? 0,
      consecutiveMonths: 0, // 下方统一计算
    });
  }
  // 从末尾向前计算连续增持月数
  let consecutive = 0;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].change > 0) {
      consecutive++;
    } else {
      break;
    }
  }
  if (result.length > 0) {
    result[result.length - 1].consecutiveMonths = consecutive;
  }
  return result;
}

/** 从金价历史计算最近 N 日涨跌幅（%） */
function computePriceChange(priceHistory: GoldPriceRecord[], days: number): number | null {
  const valid = priceHistory.filter(p => p.londonClose !== null);
  if (valid.length < days + 1) return null;
  const latest = valid[valid.length - 1];
  const past = valid[valid.length - 1 - days];
  if (latest.londonClose === null || past.londonClose === null) return null;
  return ((latest.londonClose - past.londonClose) / past.londonClose) * 100;
}

// ===== 子信号计算 =====

/**
 * 计算 CFTC 非商业净多头信号
 * @param flows 按日期升序排列的 CFTC 净多头记录
 */
export function computeCftcSignal(flows: CftcNetRecord[]): CftcSignal {
  if (flows.length < 5) {
    return {
      score: 50,
      direction: 'neutral',
      percentile: 50,
      extreme: false,
      extremeLabel: '',
      trend4w: '震荡',
      summary: 'CFTC 数据不足，暂无法判断',
    };
  }

  // 取最近 260 周（≈5年）的数据做百分位
  const lookback = flows.slice(-260);
  const allNcNet = lookback.map(f => f.ncNet);
  const latest = lookback[lookback.length - 1];
  const pct = percentile(latest.ncNet, allNcNet);

  // 近 4 周方向分：正向变化越多得分越高
  const last4Changes = flows.slice(-4).map(f => f.ncChange);
  const positiveCount = last4Changes.filter(c => c > 0).length;
  const dirScore = directionScore(positiveCount - 2, 0); // -2..2 → 30..70

  // 极端信号：高位净多开始减少（过度拥挤多头平仓）或低位净多开始增加（空头回补）
  const latestChange = latest.ncChange;
  let extremeSignal = 50;
  if (pct > 90 && latestChange < 0) extremeSignal = 25;
  else if (pct < 10 && latestChange > 0) extremeSignal = 75;

  // 综合评分
  const score = Math.round(0.4 * pct + 0.3 * dirScore + 0.2 * extremeSignal + 0.1 * 50);

  // 极端标记
  const extreme = pct > 90 || pct < 10;
  let extremeLabel = '';
  if (pct > 90) extremeLabel = '净多头处于历史高位';
  else if (pct < 10) extremeLabel = '净多头处于历史低位';

  // 近 4 周趋势
  let trend4w: string;
  if (positiveCount === 4) trend4w = '连续增加';
  else if (positiveCount === 0) trend4w = '连续减少';
  else trend4w = '震荡';

  // 方向
  const direction: Direction = score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'neutral';

  const summary = `非商业净多 ${latest.ncNet.toLocaleString()} 手 (百分位 ${Math.round(pct)}%, 近4周${trend4w})`;

  return {
    score,
    direction,
    percentile: Math.round(pct),
    extreme,
    extremeLabel,
    trend4w,
    summary,
  };
}

/**
 * 计算 ETF（GLD）资金流信号
 * @param flows 按日期升序排列的 GLD 持仓记录
 * @param londonClose 当前伦敦金收盘价（可为 null）
 */
export function computeEtfFlowSignal(flows: GldRecord[], londonClose: number | null): EtfFlowSignal {
  if (flows.length === 0) {
    return {
      score: 50,
      direction: 'neutral',
      percentile: 50,
      change5d: 0,
      change20d: 0,
      divergence: false,
      divergenceLabel: '',
      summary: 'GLD 持仓数据不足，暂无法判断',
    };
  }

  // 样本 <5：用最新吨数 + 日变化做粗判（东财新闻刚接入时常只有少数点）
  if (flows.length < 5) {
    const latest = flows[flows.length - 1];
    const ch = latest.change;
    const score = ch > 1 ? 62 : ch < -1 ? 38 : 50;
    const direction: Direction = score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'neutral';
    return {
      score,
      direction,
      percentile: 50,
      change5d: ch,
      change20d: ch,
      divergence: false,
      divergenceLabel: '',
      summary: `GLD 持仓 ${latest.tons.toFixed(1)} 吨`
        + (ch ? `（Δ${ch > 0 ? '+' : ''}${ch.toFixed(2)}吨）` : '')
        + ` · 样本仅 ${flows.length} 日，粗判`,
    };
  }

  // 5 日和 20 日持仓变化
  const change5d = flows.slice(-5).reduce((sum, f) => sum + f.change, 0);
  const change20d = flows.slice(-20).reduce((sum, f) => sum + f.change, 0);

  // 持仓量百分位
  const allTons = flows.map(f => f.tons);
  const latestTons = flows[flows.length - 1].tons;
  const pct = percentile(latestTons, allTons);

  // 方向分
  const dir5d = change5d > 0 ? 75 : change5d < 0 ? 25 : 50;
  const dir20d = change20d > 0 ? 70 : change20d < 0 ? 30 : 50;

  // 综合评分
  const score = Math.round(0.4 * dir5d + 0.3 * dir20d + 0.2 * pct + 0.1 * 50);

  const direction: Direction = score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'neutral';

  // 背离检测需要价格历史，此处仅用 londonClose 做简单判断
  // 详细背离检测在 detectDivergences 中完成
  const divergence = false;
  const divergenceLabel = '';

  // 格式化数字
  const fmt = (v: number): string => (v > 0 ? '+' : '') + v.toFixed(2);
  const summary = `GLD ${Math.round(latestTons)}吨, 5日 ${fmt(change5d)}吨, 20日 ${fmt(change20d)}吨`;

  // londonClose 仅用于标记，不影响评分（背离在 detectDivergences 中处理）
  void londonClose;

  return {
    score,
    direction,
    percentile: Math.round(pct),
    change5d: Math.round(change5d * 100) / 100,
    change20d: Math.round(change20d * 100) / 100,
    divergence,
    divergenceLabel,
    summary,
  };
}

/**
 * 计算央行（PBOC）购金信号
 * @param flows 按日期升序排列的 PBOC 黄金储备记录
 */
export function computeCentralBankSignal(flows: PbocRecord[]): CentralBankSignal {
  if (flows.length === 0) {
    return {
      score: 50,
      direction: 'neutral',
      pbocConsecutiveMonths: 0,
      pbocMonthlyChange: 0,
      summary: '暂无央行购金数据',
    };
  }

  const latest = flows[flows.length - 1];

  // 连续增持得分：连续增持月数越多得分越高，上限 90
  const consecutiveScore = latest.consecutiveMonths > 0
    ? Math.min(latest.consecutiveMonths * 2 + 50, 90)
    : 50;

  // 月度变化得分
  const changeScore = latest.change > 0 ? 70 : latest.change < 0 ? 20 : 50;

  // 综合评分
  const score = Math.round(0.5 * consecutiveScore + 0.3 * changeScore + 0.2 * 50);

  const direction: Direction = score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'neutral';

  const fmt = (v: number): string => (v > 0 ? '+' : '') + v.toFixed(1);
  const summary = latest.consecutiveMonths > 0
    ? `PBOC 连续${latest.consecutiveMonths}月增持, 月度 ${fmt(latest.change)}吨`
    : `PBOC 月度 ${fmt(latest.change)}吨`;

  return {
    score,
    direction,
    pbocConsecutiveMonths: latest.consecutiveMonths,
    pbocMonthlyChange: latest.change,
    summary,
  };
}

/**
 * 检测价格与主力动向之间的背离信号
 * @param cftc CFTC 子信号
 * @param etf ETF 子信号
 * @param londonClose 当前伦敦金收盘价（可为 null）
 * @param priceHistory 金价历史记录（按日期升序）
 */
export function detectDivergences(
  cftc: CftcSignal,
  etf: EtfFlowSignal,
  londonClose: number | null,
  priceHistory: GoldPriceRecord[],
): DivergenceSignal[] {
  const divergences: DivergenceSignal[] = [];

  if (londonClose === null) return divergences;

  // 计算最近 5 日金价涨跌幅
  const priceChange5d = computePriceChange(priceHistory, 5);
  if (priceChange5d === null) return divergences;

  const absPriceChange = Math.abs(priceChange5d);
  const severity: 'mild' | 'significant' = absPriceChange > 3 ? 'significant' : 'mild';

  // 价格-CFTC 背离
  if (cftc.trend4w === '连续减少' && priceChange5d > 1) {
    divergences.push({
      type: 'price_cftc',
      severity,
      description: `金价5日上涨${priceChange5d.toFixed(1)}%但CFTC净多近4周连续减少`,
    });
  } else if (cftc.trend4w === '连续增加' && priceChange5d < -1) {
    divergences.push({
      type: 'price_cftc',
      severity,
      description: `金价5日下跌${priceChange5d.toFixed(1)}%但CFTC净多近4周连续增加`,
    });
  }

  // 价格-ETF 背离
  if (etf.change5d < 0 && priceChange5d > 1) {
    divergences.push({
      type: 'price_etf',
      severity,
      description: `金价5日上涨${priceChange5d.toFixed(1)}%但GLD持仓5日减少${Math.abs(etf.change5d).toFixed(2)}吨`,
    });
  } else if (etf.change5d > 0 && priceChange5d < -1) {
    divergences.push({
      type: 'price_etf',
      severity,
      description: `金价5日下跌${priceChange5d.toFixed(1)}%但GLD持仓5日增加${etf.change5d.toFixed(2)}吨`,
    });
  }

  return divergences;
}

// ===== 综合信号 =====

/**
 * 从 SQLite 数据计算完整的主力动向综合信号
 * @param londonClose 当前伦敦金收盘价（可为 null，用于背离检测）
 */
export function computeInstitutionalSignal(londonClose: number | null): InstitutionalSignal {
  const db = getDb();
  const flowsRepo = new InstitutionalFlowsRepo(db);
  const goldPricesRepo = new GoldPricesRepo(db);

  // 读取 CFTC 历史（最多 260 条，repo 返回 DESC 需反转为 ASC）
  const cftcRaw = flowsRepo.getCftcHistory(260);
  cftcRaw.reverse();
  const cftcFlows = toCftcNetRecords(cftcRaw);

  // 读取全部近期数据用于 GLD 和 PBOC 筛选
  const allFlows = flowsRepo.getRecent(2000);
  const gldFlows = toGldRecords(allFlows);
  const pbocFlows = toPbocRecords(allFlows);

  // 读取最近 30 天金价用于背离检测
  const priceHistory = goldPricesRepo.getRecent(30);

  // 计算子信号
  const cftc = computeCftcSignal(cftcFlows);
  const etfFlow = computeEtfFlowSignal(gldFlows, londonClose);
  const centralBank = computeCentralBankSignal(pbocFlows);
  const divergences = detectDivergences(cftc, etfFlow, londonClose, priceHistory);

  // 综合评分：CFTC 40% + ETF 30% + 央行 15% + 预留 15%（中性 50）
  const overallScore = Math.round(
    0.40 * cftc.score + 0.30 * etfFlow.score + 0.15 * centralBank.score + 0.05 * 50 + 0.10 * 50,
  );
  const overallDirection: Direction =
    overallScore >= 60 ? 'bullish' : overallScore <= 40 ? 'bearish' : 'neutral';

  // 综合摘要
  const parts: string[] = [cftc.summary, etfFlow.summary, centralBank.summary];
  if (divergences.length > 0) {
    parts.push(`检测到${divergences.length}个背离信号`);
  }
  const summary = parts.join('；');

  return {
    cftc,
    etfFlow,
    centralBank,
    overallScore,
    overallDirection,
    divergences,
    summary,
  };
}