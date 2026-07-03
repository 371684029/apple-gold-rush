// 分析完成后的通知逻辑

import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { sendWebhook, type NotifyLevel } from './webhook-notify.js';
import type { RunManifest } from './run-manifest.js';
import { getDb } from '../db/index.js';
import { ReportsRepo } from '../db/reports.js';

export interface NotifyResult {
  sent: boolean;
  reason: string;
  level?: NotifyLevel;
}

/** 读取指定日期的 manifest */
export function loadManifestByDate(date: string): RunManifest | null {
  const file = path.resolve(process.cwd(), 'data', 'manifests', `goldrush-manifest-${date}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as RunManifest;
  } catch {
    return null;
  }
}

/** 找上一日 manifest（按文件名排序） */
export function loadPreviousManifest(beforeDate: string): RunManifest | null {
  const dir = path.resolve(process.cwd(), 'data', 'manifests');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('goldrush-manifest-') && f.endsWith('.json'))
    .map(f => f.replace('goldrush-manifest-', '').replace('.json', ''))
    .filter(d => d < beforeDate)
    .sort();
  if (files.length === 0) return null;
  return loadManifestByDate(files[files.length - 1]);
}

function yesterdayOf(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 每日任务结束通知（由 daily-analysis.sh 或 analysis 调用） */
export async function notifyDailyResult(exitCode: number): Promise<NotifyResult> {
  const cfg = getConfig();
  const alerts = cfg.alerts;
  const url = alerts.webhookUrl;
  const type = alerts.webhookType;

  if (!url) {
    return { sent: false, reason: '未配置 alerts.webhookUrl 或 GOLDRUSH_WEBHOOK_URL' };
  }

  const today = new Date().toISOString().slice(0, 10);

  if (exitCode !== 0) {
    if (!alerts.notifyOnFailure) {
      return { sent: false, reason: 'notifyOnFailure 已关闭' };
    }
    const r = await sendWebhook(url, type, {
      title: 'GoldRush 每日分析失败',
      body: `日期 ${today}\n退出码 ${exitCode}\n请查看 logs/daily-${today}.log`,
      level: 'error',
    });
    return { sent: r.sent, reason: r.sent ? '已发送失败告警' : (r.error ?? '发送失败'), level: 'error' };
  }

  const manifest = loadManifestByDate(today);
  const prev = loadPreviousManifest(today) ?? loadManifestByDate(yesterdayOf(today));

  const score = manifest?.scoreBreakdown?.finalScore;
  const prevScore = prev?.scoreBreakdown?.finalScore;
  const delta = score != null && prevScore != null ? score - prevScore : null;

  const db = getDb();
  const reportRow = new ReportsRepo(db).getByDate(today);
  const direction = reportRow?.direction ?? 'neutral';

  let level: NotifyLevel = 'info';
  let title = 'GoldRush 每日分析完成';
  const lines: string[] = [`日期 ${today}`];

  if (score != null) {
    lines.push(`综合分 **${score}**（${dirCn(direction)}）`);
  }
  if (manifest?.macroRegime?.label) {
    lines.push(`宏观 ${manifest.macroRegime.label}`);
  }
  if (delta != null) {
    lines.push(`较上一日 ${delta > 0 ? '+' : ''}${delta} 分`);
    if (Math.abs(delta) >= alerts.scoreSwingThreshold) {
      level = 'warn';
      title = 'GoldRush 评分显著变化';
      lines.push(`⚠️ 超过阈值 ${alerts.scoreSwingThreshold} 分，建议 goldrush diff`);
    }
  }
  if (manifest?.judgeVerdict?.summary) {
    lines.push(manifest.judgeVerdict.summary.slice(0, 120));
  }

  const shouldSend =
    level === 'warn'
    || alerts.notifyOnSuccess
    || (delta != null && Math.abs(delta) >= alerts.scoreSwingThreshold);

  if (!shouldSend) {
    return { sent: false, reason: '未达通知条件（可开启 notifyOnSuccess 或等待评分跳变）' };
  }

  const r = await sendWebhook(url, type, { title, body: lines.join('\n'), level });
  return { sent: r.sent, reason: r.sent ? '已发送' : (r.error ?? '发送失败'), level };
}

/** 测试 webhook 连通性 */
export async function notifyTest(): Promise<NotifyResult> {
  const cfg = getConfig();
  const url = cfg.alerts.webhookUrl;
  if (!url) {
    return { sent: false, reason: '未配置 webhook URL' };
  }
  const r = await sendWebhook(url, cfg.alerts.webhookType, {
    title: 'GoldRush 通知测试',
    body: `时间 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n配置正常，可接收每日分析告警。`,
    level: 'info',
  });
  return { sent: r.sent, reason: r.sent ? '测试消息已发送' : (r.error ?? '发送失败') };
}

function dirCn(d: string): string {
  if (d === 'bullish') return '偏多';
  if (d === 'bearish') return '偏空';
  return '中性';
}
