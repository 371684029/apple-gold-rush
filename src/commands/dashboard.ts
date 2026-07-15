// goldrush dashboard — 默认命令，一眼看懂
//
// 无参数运行 goldrush 时展示：
// 1. 实时金价（从 SQLite 最新数据）
// 2. 最新研判摘要
// 3. 主力动向摘要
// 4. 操作建议

import chalk from 'chalk';
import { getDb } from '../db/index.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import { ReportsRepo } from '../db/reports.js';
import { InstitutionalFlowsRepo } from '../db/institutional-flows.js';
import { computeInstitutionalSignal } from '../indicators/flow-signal.js';
import { scoreToAdvice } from '../utils/plain-advice.js';
import { separator, directionMark, scoreBar } from '../utils/format.js';
import { formatNow } from '../utils/time.js';

/** 计算数据年龄（人类可读） */
function getDataAge(createdAt: string): string {
  const created = new Date(createdAt + 'Z');
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - created.getTime()) / 60000);
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}小时前`;
  return `${Math.floor(diffMin / 1440)}天前`;
}

export async function dashboardCommand(): Promise<void> {
  const db = getDb();
  const priceRepo = new GoldPricesRepo(db);
  const reportsRepo = new ReportsRepo(db);
  const flowsRepo = new InstitutionalFlowsRepo(db);

  // 1. 最新金价
  const prices = priceRepo.getRecent(2);
  const latest = prices[prices.length - 1];
  const prev = prices.length >= 2 ? prices[prices.length - 2] : null;

  // 2. 最新分析报告
  const recentReports = reportsRepo.getRecent(30);
  const latestReport = recentReports.length > 0 ? recentReports[recentReports.length - 1] : null;

  // 3. 主力信号
  let flowScore: number | null = null;
  let flowDir: string = '';
  let flowSummary: string = '';
  try {
    const signal = computeInstitutionalSignal(latest?.londonClose ?? null);
    flowScore = signal.overallScore;
    flowDir = signal.overallDirection;
    flowSummary = signal.summary;
  } catch {
    // 主力数据尚未初始化
  }

  // ===== 输出 =====
  console.log(chalk.cyan(`\n🥇 GoldRush — ${formatNow()}`));

  // 金价行
  const parts: string[] = [];
  if (latest?.londonClose) {
    const chg = prev?.londonClose ? ((latest.londonClose - prev.londonClose) / prev.londonClose * 100) : 0;
    const chgStr = chg !== 0 ? ` ${chg > 0 ? chalk.red('+') : chalk.green('')}${chg.toFixed(2)}%` : '';
    parts.push(`伦敦金 ${chalk.yellow('$' + latest.londonClose.toFixed(2))}${chgStr}`);
  }
  if (latest?.shanghaiClose) {
    parts.push(`上海金 ${chalk.yellow('¥' + latest.shanghaiClose.toFixed(2))}/g`);
  }
  if (latest?.dollarIndex) {
    parts.push(`美元 ${latest.dollarIndex.toFixed(2)}`);
  }
  if (parts.length > 0) {
    console.log(chalk.gray('  ' + parts.join('  │  ')));
    // 时效标注
    if (latest?.createdAt) {
      const age = getDataAge(latest.createdAt);
      console.log(chalk.gray(`  🕐 数据更新于 ${latest.date}${age ? `（${age}）` : ''}`));
    }
  } else {
    console.log(chalk.gray('  暂无价格数据，运行 goldrush price 开始采集'));
  }

  console.log(separator('─', 55));

  // 研判行
  if (latestReport) {
    const advice = scoreToAdvice(latestReport.overallScore);
    console.log(`  📊 最新研判 (${latestReport.date})  ${latestReport.overallScore}/100  ${directionMark(latestReport.direction)}`);

    // 双打分对比：LLM vs 量化（如果 quantScore 可用）
    if (latestReport.quantScore != null) {
      const delta = latestReport.overallScore - latestReport.quantScore;
      const deltaStr = delta > 0 ? `LLM偏高 +${delta}` : delta < 0 ? `LLM偏低 ${delta}` : '一致';
      const quantDir = latestReport.quantScore >= 58 ? 'bullish' : latestReport.quantScore <= 42 ? 'bearish' : 'neutral';
      console.log(`  🔢 量化 ${latestReport.quantScore}/100 ${directionMark(quantDir)} | ${deltaStr}`);
    }

    console.log(`  💡 ${advice.emoji} ${advice.action}`);
  } else {
    console.log(chalk.gray('  📊 暂无分析报告，运行 goldrush analysis 生成第一份'));
  }

  // 主力行
  if (flowScore !== null) {
    const flowDirLabel = flowDir === 'bullish' ? '偏多' : flowDir === 'bearish' ? '偏空' : '中性';
    console.log(`  🏦 主力动向  ${flowScore}/100 ${flowDirLabel}`);
    // 只显示前 60 字摘要
    const short = flowSummary.length > 60 ? flowSummary.slice(0, 60) + '…' : flowSummary;
    console.log(chalk.gray(`     ${short}`));
  }

  console.log(separator('─', 55));
  console.log(chalk.gray('  analysis 完整报告  │  flow 主力详情  │  price 实时金价  │  calibrate 回测'));
  console.log();
}
