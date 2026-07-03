// goldrush snapshot — 手动保存数据快照
// goldrush init-history — 首次拉取历史数据

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

export async function initHistoryCommand(): Promise<void> {
  console.log('\n📜 增量积累历史数据...\n');

  const db = getDb();
  const repo = new GoldPricesRepo(db);
  const existing = repo.count();

  console.log(`  当前已有 ${existing} 条历史数据`);
  console.log('  ⚠️ 本命令只采集当日数据，不支持一次性回填历史数据。');

  // 检查今日是否已有数据，避免重复写入
  const today = todayDate();
  const existingToday = repo.getByDate(today);
  if (existingToday) {
    console.log(`  ⏭️ ${today} 的数据已存在，跳过当日采集。`);
  } else {
    const collector = new DataCollectorAgent();
    try {
      await collector.collectMarketData();
      console.log('  ✅ 当日数据已保存');
    } catch (err) {
      console.error('  ❌ 采集失败:', err instanceof Error ? err.message : err);
    } finally {
      await collector.cleanup();
    }
  }

  const finalCount = repo.count();
  console.log(`\n  📊 现有 ${finalCount} 条历史数据`);
  console.log('  💡 数据积累方式（推荐）：');
  console.log('     每日运行 goldrush price 或 goldrush snapshot，自动追加当日数据');
  console.log('     也可设置定时任务，示例 crontab：');
  console.log('     30 11 * * * cd /path/to/goldRush && node dist/index.js snapshot >> logs/daily.log 2>&1');
  console.log('  💡 至少积累 20 天后，技术指标（MA/RSI/MACD）才生效。');
}
