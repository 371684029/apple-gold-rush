// goldrush history — 查看本地历史数据/报告

import Table from 'cli-table3';
import { getDb } from '../db/index.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import { ReportsRepo } from '../db/reports.js';
import { header, directionMark } from '../utils/format.js';

export async function historyCommand(type: 'prices' | 'reports' = 'prices', days: number = 30): Promise<void> {
  const db = getDb();

  if (type === 'prices') {
    const repo = new GoldPricesRepo(db);
    const records = repo.getRecent(days);

    console.log(header('📜 GoldRush 历史金价', `最近${days}天 | 共${records.length}条`));

    if (records.length === 0) {
      console.log('\n  ⚠️ 暂无历史数据');
      console.log('  请运行 goldrush price 或 goldrush snapshot 积累数据');
      return;
    }

    const table = new Table({
      head: ['日期', '伦敦金', '上海金', 'ETF净值', '美元指数'],
      colAligns: ['left', 'right', 'right', 'right', 'right'],
      style: { head: ['cyan'] },
    });

    for (const r of records.slice(-20)) { // 最近20条
      table.push([
        r.date,
        r.londonClose != null ? `$${r.londonClose.toFixed(2)}` : 'N/A',
        r.shanghaiClose != null ? `¥${r.shanghaiClose.toFixed(2)}` : 'N/A',
        r.etfNav != null ? r.etfNav.toFixed(3) : 'N/A',
        r.dollarIndex != null ? r.dollarIndex.toFixed(2) : 'N/A',
      ]);
    }

    console.log(table.toString());
  } else {
    const repo = new ReportsRepo(db);
    const reports = repo.getRecent(days);

    console.log(header('📜 GoldRush 历史报告', `最近${days}天 | 共${reports.length}条`));

    if (reports.length === 0) {
      console.log('\n  ⚠️ 暂无历史报告');
      console.log('  请运行 goldrush analysis 积累分析数据');
      return;
    }

    const table = new Table({
      head: ['日期', '评分', '方向', '视角'],
      colAligns: ['left', 'right', 'left', 'left'],
      style: { head: ['cyan'] },
    });

    for (const r of reports) {
      table.push([r.date, `${r.overallScore}/100`, directionMark(r.direction), r.horizon]);
    }

    console.log(table.toString());
  }
}
