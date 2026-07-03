// goldrush notify — Webhook 告警

import { notifyDailyResult, notifyTest } from '../utils/notify-daily.js';

export async function notifyCommand(options: {
  test: boolean;
  daily: boolean;
  exitCode: number;
}): Promise<void> {
  if (options.test) {
    const r = await notifyTest();
    console.log(r.sent ? `✅ ${r.reason}` : `⚠️ ${r.reason}`);
    if (!r.sent && r.reason.includes('未配置')) process.exitCode = 1;
    return;
  }

  if (options.daily) {
    const r = await notifyDailyResult(options.exitCode);
    if (r.sent) {
      console.log(`📣 ${r.reason}${r.level ? ` (${r.level})` : ''}`);
    } else {
      console.log(`📭 ${r.reason}`);
    }
    return;
  }

  console.log('用法:');
  console.log('  goldrush notify --test              # 测试 Webhook');
  console.log('  goldrush notify --daily --exit 0    # 每日任务结束后通知');
}
