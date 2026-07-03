#!/usr/bin/env node
// GoldRush — 黄金投资研究 Agent CLI 入口

import { Command } from 'commander';
import { priceCommand } from './commands/price.js';
import { analysisCommand } from './commands/analysis.js';
import { fundCommand } from './commands/fund.js';
import { calibrateCommand } from './commands/calibrate.js';
import { snapshotCommand, initHistoryCommand } from './commands/snapshot.js';
import { historyCommand } from './commands/history.js';
import { diffCommand } from './commands/diff.js';
import { digestCommand } from './commands/digest.js';
import { notifyCommand } from './commands/notify.js';
import { closeDb } from './db/index.js';
import { loadConfig } from './utils/config.js';

// 加载 dotenv
try {
  const dotenv = await import('dotenv');
  dotenv.config();
} catch { /* ignore */ }

// 加载配置
loadConfig();

const program = new Command();

program
  .name('goldrush')
  .description('🥇 GoldRush — 黄金投资研究 Agent')
  .version('0.1.0');

// P0: 实时金价速查
program
  .command('price')
  .description('实时金价速查（自动存SQLite）')
  .option('--detail', '更详细的多市场数据')
  .action(async (opts) => {
    try {
      await priceCommand(opts.detail ?? false);
    } finally {
      closeDb();
    }
  });

// P1: 综合分析报告
program
  .command('analysis')
  .description('综合分析报告（默认输出双视角：短期 + 中长期）')
  .option('-H, --horizon <type>', '输出视角: short/mid/all', 'all')
  .option('--json', '输出 JSON（默认 schema v1，含 manifest）')
  .option('--json-legacy', 'JSON 仅输出报告本体，不含 manifest')
  .option('--save', '保存报告到文件 (JSON schema v1)')
  .option('--md', '保存报告为 Markdown 格式')
  .action(async (opts) => {
    const horizon = opts.horizon as 'short' | 'mid' | 'all';
    if (!['short', 'mid', 'all'].includes(horizon)) {
      console.error('❌ --horizon 必须是 short, mid 或 all');
      process.exit(1);
    }
    try {
      const exitCode = await analysisCommand({
        horizon,
        json: opts.json ?? false,
        jsonLegacy: opts.jsonLegacy ?? false,
        save: opts.save ?? false,
        md: opts.md ?? false,
      });
      if (exitCode !== 0) process.exit(exitCode);
    } finally {
      closeDb();
    }
  });

// P1: 基金面专项
program
  .command('fund')
  .description('黄金基金对比分析（费率/溢价/定投信号）')
  .action(async () => {
    try {
      await fundCommand();
    } finally {
      closeDb();
    }
  });

// P1: 回测校准
program
  .command('calibrate')
  .description('回测校准（验证历史分析准确率）')
  .option('--days <n>', '回顾天数', '30')
  .option('--detail', '按评分区间细分校准')
  .option('--tearsheet', '输出区间收益分布与模拟权益曲线')
  .option('--md', '导出 Tearsheet 到 docs/')
  .action(async (opts) => {
    try {
      await calibrateCommand({
        days: parseInt(opts.days, 10) || 30,
        detail: opts.detail ?? false,
        tearsheet: opts.tearsheet ?? false,
        md: opts.md ?? false,
      });
    } finally {
      closeDb();
    }
  });

// P1: 数据管理
program
  .command('snapshot')
  .description('手动保存当日数据快照到SQLite')
  .action(async () => {
    try {
      await snapshotCommand();
    } finally {
      closeDb();
    }
  });

program
  .command('init-history')
  .description('首次运行：拉取最近60天历史数据')
  .action(async () => {
    try {
      await initHistoryCommand();
    } finally {
      closeDb();
    }
  });

program
  .command('history')
  .description('查看本地历史数据和报告')
  .option('--type <type>', '查看类型: prices/reports', 'prices')
  .option('--days <n>', '查看天数', '30')
  .action(async (opts) => {
    const type = opts.type as string;
    if (!['prices', 'reports'].includes(type)) {
      console.error('❌ --type 必须是 prices 或 reports');
      process.exit(1);
    }
    try {
      await historyCommand(type as 'prices' | 'reports', parseInt(opts.days, 10) || 30);
    } finally {
      closeDb();
    }
  });

program
  .command('digest')
  .description('周期摘要（均分、多空天数、最大跳变）')
  .option('--days <n>', '回顾天数', '7')
  .option('--md', '写入 docs/goldrush-digest-latest.md')
  .option('--json', 'JSON 输出')
  .action(async (opts) => {
    try {
      digestCommand(parseInt(opts.days, 10) || 7, opts.md ?? false, opts.json ?? false);
    } finally {
      closeDb();
    }
  });

program
  .command('notify')
  .description('Webhook 告警（测试 / 每日任务结束）')
  .option('--test', '发送测试消息')
  .option('--daily', '每日分析结束后通知')
  .option('--exit <n>', '分析退出码（与 --daily 配合）', '0')
  .action(async (opts) => {
    try {
      await notifyCommand({
        test: opts.test ?? false,
        daily: opts.daily ?? false,
        exitCode: parseInt(opts.exit, 10) || 0,
      });
    } finally {
      closeDb();
    }
  });

program
  .command('diff <dateA> <dateB>')
  .description('对比两日分析报告（评分/维度/情景概率变化）')
  .option('--json', '输出 JSON')
  .action(async (dateA: string, dateB: string, opts) => {
    try {
      diffCommand(dateA, dateB, opts.json ?? false);
    } finally {
      closeDb();
    }
  });

program.parse();
