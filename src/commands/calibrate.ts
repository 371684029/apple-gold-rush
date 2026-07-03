// goldrush calibrate — 回测校准

import { getDb } from '../db/index.js';
import { CalibrationRepo } from '../db/calibration.js';
import { ReportsRepo } from '../db/reports.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import {
  buildCalibrationTearsheet,
  formatTearsheetConsole,
  formatTearsheetMarkdown,
} from '../utils/calibration-tearsheet.js';
import { renderEquityCurveSvg } from '../utils/chart-svg.js';
import { header, separator } from '../utils/format.js';
import chalk from 'chalk';
import type { CalibrateOptions } from '../types/config.js';

export async function calibrateCommand(options: CalibrateOptions): Promise<void> {
  console.log('\n📊 GoldRush 校准报告生成中...\n');

  const db = getDb();
  const repo = new CalibrationRepo(db);

  // 自动回填
  const filled = repo.backfillPending();
  if (filled > 0) {
    console.log(`  ✅ 回填了 ${filled} 条历史数据`);
  }

  // 计算校准
  const report = repo.computeCalibration(options.days);

  let tearsheet = null as ReturnType<typeof buildCalibrationTearsheet> | null;
  if (options.tearsheet || options.md) {
    const reports = new ReportsRepo(db).getRecent(options.days);
    tearsheet = buildCalibrationTearsheet(reports, new GoldPricesRepo(db));
  }

  // 输出
  console.log(header('📊 GoldRush 置信度校准报告', `过去${report.period.days}天 | ${report.period.from} ~ ${report.period.to}`));
  console.log(`  分析报告总数: ${report.totalReports}条 | 有效回填: ${report.validReports}条`);

  if (report.buckets.length === 0) {
    console.log('\n  ⚠️ 暂无足够的历史数据进行校准');
    console.log('  请先运行 goldrush analysis 多次积累数据');
    console.log(separator('═', 55));
    return;
  }

  // 校准表格
  console.log(`\n  📈 评分区间校准\n`);
  console.log('  评分区间  样本  实际涨概率  平均涨幅  偏差      系统偏差');
  console.log(separator('─', 55));

  for (const bucket of report.buckets) {
    const biasStr = bucket.systematicBias === 'optimistic'
      ? chalk.red(`偏乐观${bucket.calibrationError.toFixed(0)}%`)
      : bucket.systematicBias === 'pessimistic'
        ? chalk.green(`偏保守${bucket.calibrationError.toFixed(0)}%`)
        : chalk.cyan('校准良好');

    const systemBiasStr = bucket.systematicBias === 'optimistic' ? '乐观'
      : bucket.systematicBias === 'pessimistic' ? '保守'
        : '校准';

    console.log(`  ${bucket.scoreRange.padEnd(8)} ${String(bucket.sampleSize).padStart(4)}  ${(bucket.actualUpProbability * 100).toFixed(0).padStart(8)}%    ${bucket.avgReturn > 0 ? '+' : ''}${bucket.avgReturn.toFixed(1).padStart(6)}%   ${biasStr}  ${systemBiasStr}`);
  }

  // --detail：按评分区间展开明细
  if (options.detail) {
    console.log(`\n  🔍 区间明细\n`);
    for (const bucket of report.buckets) {
      console.log(`  ${bucket.scoreRange}: 预测方向=${bucket.predictedDirection} | 实际上涨 ${bucket.actualUpCount}/${bucket.sampleSize} | 校准误差 ${bucket.calibrationError.toFixed(1)}% | 系统偏差=${bucket.systematicBias}`);
    }
  }

  // 整体偏差
  const biasDir = report.overallBias > 0 ? '偏乐观' : report.overallBias < 0 ? '偏保守' : '校准良好';
  console.log(`\n  ⚠️ 系统偏差: 整体${biasDir} ${Math.abs(report.overallBias).toFixed(1)}%`);

  // 风险预警质量
  const rq = report.riskAlertQuality;
  console.log(`\n  🚨 风险预警质量\n`);
  console.log(`  红灯触发: ${rq.redAlertCount}次`);
  console.log(`  红灯命中: ${rq.redAlertHitCount}次 (命中率${(rq.redAlertHitRate * 100).toFixed(0)}%) ${rq.redAlertHitRate > 0.6 ? '✅' : '⚠️'}`);
  console.log(`  漏报次数: ${rq.missedAlerts}次 (漏报率${(rq.missedRate * 100).toFixed(0)}%) ${rq.missedRate < 0.25 ? '✅' : '⚠️'}`);

  // 建议
  console.log(`\n  💡 改进建议`);
  for (const rec of report.recommendations) {
    console.log(`  · ${rec}`);
  }

  if (tearsheet && options.tearsheet) {
    console.log(formatTearsheetConsole(tearsheet));
  }

  if (tearsheet && options.md) {
    const fs = await import('node:fs');
    const docsDir = 'docs';
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
    const periodLabel = `过去${report.period.days}天 (${report.period.from} ~ ${report.period.to})`;
    const content = formatTearsheetMarkdown(tearsheet, periodLabel);
    const dated = `${docsDir}/goldrush-calibration-${new Date().toISOString().slice(0, 10)}.md`;
    const latest = `${docsDir}/goldrush-calibration-latest.md`;
    fs.writeFileSync(dated, content, 'utf-8');
    fs.writeFileSync(latest, content, 'utf-8');
    if (tearsheet.equityCurve.length >= 2) {
      const svg = renderEquityCurveSvg(tearsheet.equityCurve);
      const svgLatest = `${docsDir}/goldrush-calibration-equity-latest.svg`;
      fs.writeFileSync(svgLatest, svg, 'utf-8');
      console.log(`  📈 权益曲线 SVG: ${svgLatest}`);
    }
    console.log(`\n  📝 Tearsheet 已写入 ${dated}`);
  }

  console.log(separator('═', 55));
}
