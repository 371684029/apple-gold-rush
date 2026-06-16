// goldrush price — 实时金价速查

import { DataCollectorAgent } from '../agents/data-collector.js';
import { ValidatorAgent } from '../agents/validator.js';
import { header, gradeMark, changeColor, formatPrice, sessionMark, separator } from '../utils/format.js';
import { getTradingTime, formatNow } from '../utils/time.js';
import type { MarketData } from '../types/market.js';

export async function priceCommand(detail: boolean = false): Promise<void> {
  console.log('\n📊 正在采集金价数据...\n');

  // 采集数据
  const collector = new DataCollectorAgent();
  let marketData: MarketData;

  try {
    marketData = await collector.collectMarketData();
  } catch (err) {
    console.error('数据采集失败:', err instanceof Error ? err.message : err);
    console.log('\n⚠️ 使用模拟数据演示...');

    // 降级：输出提示
    console.log(header('🥇 GoldRush 实时金价', `${formatNow()} | 数据采集失败`));
    console.log('\n  数据采集遇到问题，请检查：');
    console.log('  1. opencode SDK 是否正常运行');
    console.log('  2. TAVILY_API_KEY 是否已设置（可选）');
    console.log('  3. 网络连接是否正常');
    await collector.cleanup();
    return;
  }

  // 验证数据
  const validator = new ValidatorAgent();
  const validation = await validator.validate(marketData);

  // 格式化输出
  const tradingTime = getTradingTime();
  const dataTime = new Date(marketData.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  console.log(header('🥇 GoldRush 实时金价', `${formatNow()} | ${sessionMark(tradingTime.session)} ${tradingTime.description}`));

  // 价格表格
  const rows: string[][] = [];

  // 伦敦金
  if (marketData.london.price.value) {
    rows.push([
      '伦敦金 (XAU)',
      formatPrice(marketData.london.price.value, 'USD'),
      changeColor(marketData.london.price.change),
      gradeMark(marketData.london.price.sourceGrade),
    ]);
  }

  // 上海金
  if (marketData.shanghai.price?.value) {
    rows.push([
      '上海金 (Au99.99)',
      formatPrice(marketData.shanghai.price.value, 'CNY') + '/g',
      changeColor(marketData.shanghai.price.change),
      gradeMark(marketData.shanghai.price.sourceGrade),
    ]);
  }

  // 黄金ETF
  if (marketData.etf.nav?.value) {
    rows.push([
      `黄金ETF (${marketData.etf.code})`,
      marketData.etf.nav.value.toFixed(3),
      changeColor(marketData.etf.nav.change),
      gradeMark(marketData.etf.nav.sourceGrade),
    ]);
  }

  // 美元指数
  if (marketData.dollarIndex.value?.value) {
    rows.push([
      '美元指数 (DXY)',
      marketData.dollarIndex.value.value.toFixed(2),
      changeColor(marketData.dollarIndex.value.change),
      gradeMark(marketData.dollarIndex.value.sourceGrade),
    ]);
  }

  // 美债
  if (marketData.usTreasury.yield10y?.value) {
    rows.push([
      '10Y美债收益率',
      marketData.usTreasury.yield10y.value.toFixed(2) + '%',
      changeColor(marketData.usTreasury.yield10y.change),
      gradeMark(marketData.usTreasury.yield10y.sourceGrade),
    ]);
  }

  // TIPS
  if (marketData.usTreasury.tips?.value) {
    rows.push([
      'TIPS实际利率',
      marketData.usTreasury.tips.value.toFixed(2) + '%',
      '--',
      gradeMark(marketData.usTreasury.tips.sourceGrade),
    ]);
  }

  // 输出表格
  for (const row of rows) {
    console.log(`  ${row[0].padEnd(18)} ${row[1].padStart(14)} ${row[2].padStart(12)} ${row[3]}`);
  }

  // 数据质量
  console.log(separator('─', 55));
  console.log(`  数据时间: ${dataTime}`);
  console.log(`  整体置信度: ${validation.overallConfidence}%`);
  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) {
      console.log(`  ${w}`);
    }
  }
  console.log(separator('═', 55));

  // 清理
  await collector.cleanup();
  await validator.cleanup();
}
