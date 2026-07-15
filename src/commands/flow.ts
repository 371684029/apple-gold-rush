// goldrush flow — 主力动向监测
//
// 纯本地计算，不调用 LLM。展示 CFTC 持仓、ETF 资金流、央行购金、
// 背离检测、综合主力评分。

import chalk from 'chalk';
import Table from 'cli-table3';
import fs from 'node:fs';
import { getDb } from '../db/index.js';
import { InstitutionalFlowsRepo } from '../db/institutional-flows.js';
import { ensureInstitutionalFlows } from '../utils/ensure-flows.js';
import { computeInstitutionalSignal } from '../indicators/flow-signal.js';
import { header, separator, directionMark, scoreBar } from '../utils/format.js';
import { formatNow, todayDate } from '../utils/time.js';
import { fetchGldHoldings } from '../data/etf-grabber.js';
import { fetchCftcHistory } from '../data/cftc-grabber.js';

export interface FlowOptions {
  json?: boolean;
  md?: boolean;
  cftcOnly?: boolean;
  etfOnly?: boolean;
  init?: boolean;
  days?: number;
}

export async function flowCommand(options: FlowOptions = {}): Promise<void> {
  const db = getDb();
  const repo = new InstitutionalFlowsRepo(db);

  // --init: 回填全部历史数据
  if (options.init) {
    await initAllHistory(repo);
    return;
  }

  // 自动补齐最新数据（非 --init 模式下）
  console.log(chalk.gray('  📡 检查主力数据更新...'));
  const ensured = await ensureInstitutionalFlows(repo);
  if (ensured.cftc.fetched || ensured.gld.fetched || ensured.pboc.fetched) {
    const parts: string[] = [];
    if (ensured.cftc.fetched) parts.push(`CFTC +${ensured.cftc.records}条`);
    if (ensured.gld.fetched) parts.push(`GLD +${ensured.gld.records}条`);
    if (ensured.pboc.fetched) parts.push(`PBOC +${ensured.pboc.records}条`);
    console.log(chalk.green(`  ✅ 已更新: ${parts.join(', ')}`));
    if (ensured.gld.error) console.log(chalk.yellow(`  ⚠️ GLD: ${ensured.gld.error}`));
    if (ensured.pboc.error) console.log(chalk.yellow(`  ⚠️ PBOC: ${ensured.pboc.error}`));
  } else {
    console.log(chalk.gray('  ✅ 数据已是最新'));
    if (ensured.gld.error) console.log(chalk.yellow(`  ⚠️ GLD: ${ensured.gld.error}`));
    if (ensured.pboc.error) console.log(chalk.yellow(`  ⚠️ PBOC: ${ensured.pboc.error}`));
  }

  // 计算主力信号
  const signal = computeInstitutionalSignal(null);

  if (options.json) {
    console.log(JSON.stringify(signal, null, 2));
    return;
  }

  if (options.md) {
    writeMarkdown(signal, options);
    return;
  }

  // ===== 终端表格输出 =====
  printFlowReport(signal, options);
}

/** --init: 回填 CFTC 历史（当前年份） + GLD 全部历史 */
async function initAllHistory(repo: InstitutionalFlowsRepo): Promise<void> {
  console.log(chalk.cyan('\n🔧 GoldRush 主力数据初始化...\n'));

  // CFTC 当前年份
  const year = new Date().getFullYear();
  console.log(chalk.gray(`  📡 拉取 ${year} 年 CFTC COT 报告...`));
  let cftcCount = 0;
  try {
    const cftcRecords = await fetchCftcHistory(year);
    for (const r of cftcRecords) {
      repo.upsert({
        date: r.date,
        cftcNcLong: r.nonCommLong,
        cftcNcShort: r.nonCommShort,
        cftcNcNet: r.nonCommNet,
        cftcNcChange: r.nonCommNetChange,
        cftcCommNet: r.commNet,
        cftcOpenInterest: r.openInterest,
        cftcReportDate: r.date,
        gldHoldingsTons: null, gldHoldingsChange: null, gldAumMillion: null,
        iauHoldingsTons: null,
        cnEtf518880Shares: null, cnEtf518880Flow: null,
        cnEtf159934Shares: null, cnEtf159934Flow: null,
        cbPbocReserves: null, cbPbocChange: null,
        comexVolume: null,
      });
      cftcCount++;
    }
    console.log(chalk.green(`  ✅ CFTC: ${cftcCount} 条`));
  } catch (err) {
    console.warn(chalk.yellow(`  ⚠️ CFTC 失败: ${err instanceof Error ? err.message : err}`));
  }

  // GLD 全部历史
  console.log(chalk.gray('  📡 拉取 GLD ETF 全部历史持仓...'));
  let gldCount = 0;
  try {
    const gldHoldings = await fetchGldHoldings();
    for (const h of gldHoldings) {
      const existing = repo.getByDate(h.date);
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
      gldCount++;
    }
    console.log(chalk.green(`  ✅ GLD: ${gldCount} 条`));
  } catch (err) {
    console.warn(chalk.yellow(`  ⚠️ GLD 失败: ${err instanceof Error ? err.message : err}`));
  }

  const total = repo.count();
  console.log(chalk.cyan(`\n📦 初始化完成: CFTC ${cftcCount} + GLD ${gldCount} = 总计 ${total} 行\n`));
  console.log(chalk.gray('  运行 goldrush flow 查看主力信号'));
}

/** 终端打印主力报告 */
function printFlowReport(signal: any, options: FlowOptions): void {
  const { cftc, etfFlow, centralBank, overallScore, overallDirection, divergences, summary } = signal;

  console.log(header('🏦 GoldRush 主力动向监测', formatNow()));

  if (!options.etfOnly) {
    // CFTC 持仓
    console.log(chalk.cyan('\n━━━ 📊 CFTC 持仓 (COT 报告) ━━━'));
    console.log(`  方向: ${directionMark(cftc.direction)}  评分: ${cftc.score}/100`);
    console.log(`  ${scoreBar(cftc.score)}`);
    console.log(`  ${cftc.summary}`);
    if (cftc.extreme) {
      console.log(chalk.yellow(`  ⚠️ ${cftc.extremeLabel}`));
    }
  }

  if (!options.cftcOnly) {
    // ETF 资金流
    console.log(chalk.cyan('\n━━━ 📈 ETF 资金流 (GLD) ━━━'));
    console.log(`  方向: ${directionMark(etfFlow.direction)}  评分: ${etfFlow.score}/100`);
    console.log(`  ${scoreBar(etfFlow.score)}`);
    console.log(`  ${etfFlow.summary}`);
    if (etfFlow.divergence) {
      console.log(chalk.yellow(`  ⚠️ ${etfFlow.divergenceLabel}`));
    }

    // 央行购金
    console.log(chalk.cyan('\n━━━ 🏛️ 央行购金 (PBOC) ━━━'));
    console.log(`  方向: ${directionMark(centralBank.direction)}  评分: ${centralBank.score}/100`);
    console.log(`  ${scoreBar(centralBank.score)}`);
    console.log(`  ${centralBank.summary}`);
  }

  if (!options.cftcOnly && !options.etfOnly) {
    // 背离检测
    if (divergences.length > 0) {
      console.log(chalk.yellow('\n━━━ 🔍 背离检测 ━━━'));
      for (const d of divergences) {
        const icon = d.severity === 'significant' ? '🔴' : '⚠️';
        console.log(`  ${icon} ${d.description}`);
      }
    }

    // 综合评分
    console.log(chalk.cyan('\n━━━ 📊 主力综合信号 ━━━'));
    const dirColor = overallDirection === 'bullish' ? chalk.red : overallDirection === 'bearish' ? chalk.green : chalk.yellow;
    console.log(dirColor(`  综合评分: ${overallScore}/100  ${directionMark(overallDirection)}`));
    console.log(`  ${scoreBar(overallScore)}`);
    console.log(chalk.gray(`\n  ${summary}`));

    // 评分明细表
    const table = new Table({
      head: ['维度', '权重', '评分', '方向'],
      colWidths: [12, 8, 8, 10],
      style: { head: ['cyan'] },
    });
    table.push(
      ['CFTC', '40%', `${cftc.score}`, directionMark(cftc.direction)],
      ['ETF', '30%', `${etfFlow.score}`, directionMark(etfFlow.direction)],
      ['央行', '15%', `${centralBank.score}`, directionMark(centralBank.direction)],
      ['综合', '100%', `${overallScore}`, directionMark(overallDirection)],
    );
    console.log(`\n${table.toString()}`);
  }

  console.log(separator('═', 55));
}

/** 生成并保存 Markdown 日报 */
function writeMarkdown(signal: any, options: FlowOptions): void {
  const { cftc, etfFlow, centralBank, overallScore, overallDirection, divergences, summary } = signal;
  const date = todayDate();
  const now = formatNow();

  const md = [
    `# 🏦 GoldRush 主力动向监测`,
    ``,
    `> ${now} | 纯本地计算 · 不依赖 LLM`,
    ``,
    `## 📊 综合评分`,
    ``,
    `**${overallScore}/100** — ${
      overallDirection === 'bullish' ? '📈 偏多' : overallDirection === 'bearish' ? '📉 偏空' : '➡️ 中性'
    }`,
    ``,
    `| 维度 | 权重 | 评分 | 方向 |`,
    `|------|------|------|------|`,
    `| CFTC 投机持仓 | 40% | ${cftc.score} | ${cftc.direction} |`,
    `| GLD ETF 资金流 | 30% | ${etfFlow.score} | ${etfFlow.direction} |`,
    `| 央行购金 | 15% | ${centralBank.score} | ${centralBank.direction} |`,
    `| **综合** | **100%** | **${overallScore}** | **${overallDirection}** |`,
    ``,
    `> ${summary}`,
    ``,
    `## 📊 CFTC 持仓`,
    ``,
    `- 评分: ${cftc.score}/100 (${cftc.direction})`,
    `- ${cftc.summary}`,
    cftc.extreme ? `- ⚠️ ${cftc.extremeLabel}` : '',
    ``,
    `## 📈 GLD ETF 资金流`,
    ``,
    `- 评分: ${etfFlow.score}/100 (${etfFlow.direction})`,
    `- ${etfFlow.summary}`,
    `- 5日变化: ${etfFlow.change5d > 0 ? '+' : ''}${etfFlow.change5d.toFixed(2)} 吨`,
    `- 20日变化: ${etfFlow.change20d > 0 ? '+' : ''}${etfFlow.change20d.toFixed(2)} 吨`,
    `- 持仓百分位: ${etfFlow.percentile}%`,
    ``,
    `## 🏛️ 央行购金`,
    ``,
    `- 评分: ${centralBank.score}/100 (${centralBank.direction})`,
    `- ${centralBank.summary}`,
    ``,
  ];

  if (divergences.length > 0) {
    md.push(`## 🔍 背离信号`, ``,
      ...divergences.map((d: any) => `- ${d.severity === 'significant' ? '🔴' : '⚠️'} ${d.description}`),
      ``);
  }

  md.push(`---`, ``, `> 报告由 GoldRush 自动生成 · 仅供研究参考，不构成投资建议`);

  const content = md.filter(l => l !== null).join('\n');

  const docsDir = 'docs';
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
  const filename = `${docsDir}/goldrush-flow-${date}.md`;
  fs.writeFileSync(filename, content, 'utf-8');
  console.log(chalk.green(`\n📝 主力日报已保存: ${filename}`));
}
