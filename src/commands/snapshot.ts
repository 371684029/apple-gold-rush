// goldrush snapshot — 手动保存数据快照
// goldrush init-history — 回填历史 + 当日采集

import { getDb } from '../db/index.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import { DataCollectorAgent } from '../agents/data-collector.js';
import { todayDate } from '../utils/time.js';

export async function snapshotCommand(): Promise<void> {
  console.log('\n📸 保存数据快照...\n');

  const db = getDb();
  const repo = new GoldPricesRepo(db);

  // 检查今日是否已有数据
  const today = todayDate();
  const existing = repo.getByDate(today);

  if (existing) {
    console.log(`  ⚠️ ${today} 的数据已存在`);
    console.log(`  伦敦金: $${existing.londonClose ?? 'N/A'}`);
    console.log(`  如需更新，请运行 goldrush price`);
    return;
  }

  // 采集数据
  console.log('  采集当前市场数据...');
  const collector = new DataCollectorAgent();
  try {
    const marketData = await collector.collectMarketData();
    console.log('  ✅ 数据已自动保存到 SQLite');
    console.log(`  伦敦金: $${marketData.london.price.value}`);
    console.log(`  上海金: ¥${marketData.shanghai.price.value}/g`);
  } catch (err) {
    console.error('  ❌ 采集失败:', err instanceof Error ? err.message : err);
  } finally {
    await collector.cleanup();
  }
}

export async function initHistoryCommand(days = 60): Promise<void> {
  console.log(`\n📜 历史数据初始化（目标 ${days} 天）...\n`);

  const db = getDb();
  const repo = new GoldPricesRepo(db);
  const before = repo.count();

  console.log(`  当前已有 ${before} 条历史数据`);

  const collector = new DataCollectorAgent();
  try {
    console.log(`  🔍 回填缺失的 london_close（最多 ${days} 天）...`);
    const { filled, attempted } = await collector.backfillHistory(days);
    if (attempted === 0) {
      console.log('  ✅ 过去区间无缺失日，跳过回填');
    } else if (filled === 0) {
      console.log(`  ⚠️ 未能从搜索中提取到 ${attempted} 个缺失日的收盘价（请稍后重试或每日 snapshot 积累）`);
    } else {
      console.log(`  ✅ 回填 ${filled}/${attempted} 个缺失日`);
    }

    const today = todayDate();
    if (!repo.getByDate(today)) {
      console.log('  📸 采集当日数据...');
      await collector.collectMarketData();
      console.log('  ✅ 当日数据已保存');
    } else {
      console.log(`  ⏭️ ${today} 已有数据，跳过当日采集`);
    }
  } catch (err) {
    console.error('  ❌ 初始化失败:', err instanceof Error ? err.message : err);
  } finally {
    await collector.cleanup();
  }

  const finalCount = repo.count();
  console.log(`\n  📊 现有 ${finalCount} 条历史数据（+${finalCount - before}）`);
  console.log('  💡 建议每日运行 goldrush price 或 goldrush snapshot 持续追加');
  console.log('  💡 至少积累 20 天后，技术指标（MA/RSI/MACD）才生效。');
}
