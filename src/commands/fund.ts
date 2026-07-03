// goldrush fund — 黄金基金对比分析

import { DataCollectorAgent } from '../agents/data-collector.js';
import { FundAgent } from '../agents/analysis-agents.js';
import { getDb } from '../db/index.js';
import { FundNavRepo } from '../db/fund-nav.js';
import { TRACKED_FUNDS } from '../types/fund.js';
import { pctChangeSince } from '../utils/fund-nav-stats.js';
import { header, separator, valuationMark } from '../utils/format.js';
import { formatNow } from '../utils/time.js';
import Table from 'cli-table3';
import chalk from 'chalk';

function buildFundNavContext(): string {
  const db = getDb();
  const repo = new FundNavRepo(db);
  const lines: string[] = [];
  for (const f of TRACKED_FUNDS) {
    const recent = repo.getRecent(f.code, 95);
    if (recent.length === 0) continue;
    const latest = recent[recent.length - 1];
    const c1w = pctChangeSince(recent, 7);
    const c1m = pctChangeSince(recent, 30);
    lines.push(
      `${f.code} ${f.name}: nav=${latest.nav} `
      + `1w=${c1w != null ? c1w.toFixed(2) : 'N/A'}% `
      + `1m=${c1m != null ? c1m.toFixed(2) : 'N/A'}%`,
    );
  }
  return lines.join('\n');
}

export async function fundCommand(): Promise<void> {
  console.log('\n💰 GoldRush 基金分析启动...\n');

  const collector = new DataCollectorAgent();
  let marketData;
  try {
    marketData = await collector.collectMarketData();
    try {
      await collector.collectFundNavs();
    } catch (err) {
      console.error('  ⚠️ 基金净值采集失败:', err instanceof Error ? err.message : err);
    }
  } catch (err) {
    console.error('数据采集失败:', err instanceof Error ? err.message : err);
    await collector.cleanup();
    return;
  }

  const fundAgent = new FundAgent();
  const navContext = buildFundNavContext();
  const analysis = await fundAgent.analyze(marketData, navContext);

  console.log(header('💰 GoldRush 黄金基金分析', `${formatNow()} | 面向支付宝中期配置`));

  const table = new Table({
    head: ['基金', '类型', '最新净值', '近1月', '费率', '规模', '适合'],
    colWidths: [16, 6, 10, 8, 8, 8, 16],
    style: { head: ['cyan'] },
  });

  for (const f of (analysis.funds ?? [])) {
    table.push([
      f.name.slice(0, 8),
      String(f.type).replace('ETF', '场内').slice(0, 4),
      f.nav.toFixed(4),
      f.change1m > 0 ? chalk.red(`+${f.change1m.toFixed(1)}%`) : chalk.green(`${f.change1m.toFixed(1)}%`),
      f.feeRate.toFixed(2) + '%',
      f.scale + '亿',
      f.recommendation,
    ]);
  }

  if ((analysis.funds ?? []).length === 0) {
    console.log('\n  ⚠️ 基金对比表为空（LLM 未返回 funds 或采集失败）');
  } else {
    console.log('\n' + table.toString());
  }

  console.log(`\n  📈 估值水位: ${valuationMark(analysis.valuation.level)}`);
  console.log(`  ${analysis.valuation.indicator}`);
  console.log(`  建议: ${analysis.valuation.action}`);

  const pd = analysis.premiumDiscount;
  const pdMark = pd.current > 0 ? chalk.red(`溢价${pd.current.toFixed(2)}%`) : pd.current < 0 ? chalk.green(`折价${Math.abs(pd.current).toFixed(2)}%`) : '合理';
  console.log(`\n  💹 溢价折价: ${pdMark}`);
  console.log(`  ${pd.advice}`);

  console.log(`\n${separator('━', 55)}`);
  console.log(`  🎯 推荐配置`);
  console.log(`  定投基础仓: ${analysis.recommendation.longTerm}`);
  console.log(`  波段加减仓: ${analysis.recommendation.mediumTerm}`);
  console.log(`  定投入门: ${analysis.recommendation.dipBuy}`);
  console.log(separator('═', 55));

  await collector.cleanup();
  await fundAgent.cleanup();
}
