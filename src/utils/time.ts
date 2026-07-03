// 交易时间判断

import type { TradingTimeInfo, TradingSession } from '../types/market.js';

/** 上海时区（Asia/Shanghai）日历分量 */
interface ShanghaiParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=周日 ... 6=周六
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * 用 Intl 取得给定时刻在 Asia/Shanghai 时区下的日历分量。
 * 不依赖运行机器的本地时区，避免在 UTC+8 机器上手动偏移被抵消的 bug。
 */
function getShanghaiParts(now: Date = new Date()): ShanghaiParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);

  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // 部分运行时把午夜渲染为 24 时

  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour,
    minute: parseInt(get('minute'), 10),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/**
 * 判断当前是否为交易时间
 * 伦敦金: 24小时交易（周一早7点 ~ 周六凌晨3点 UTC）
 * 上海金: 日盘 9:00-15:30, 夜盘 20:00-02:30 (CST)
 * 黄金ETF: 9:30-11:30, 13:00-15:00 (CST, T+1)
 */
export function getTradingTime(timezone: 'CST' | 'UTC' = 'CST', now: Date = new Date()): TradingTimeInfo {
  void timezone; // 当前统一按上海时区判断，预留参数以兼容调用方

  const { weekday: day, hour, minute } = getShanghaiParts(now);

  // 判断是否为交易日（周一~周五）
  const isTradingDay = day >= 1 && day <= 5;

  // 判断交易时段
  let session: TradingSession = 'closed';
  let description = '';

  if (!isTradingDay) {
    session = 'closed';
    description = day === 6 ? '周六休市' : '周日休市';
  } else if (hour >= 20 || hour < 2 || (hour === 2 && minute <= 30)) {
    // 夜盘（20:00 ~ 次日02:30）
    session = 'night';
    description = '夜盘交易中';
  } else if (hour >= 9 && (hour < 11 || (hour === 11 && minute <= 30))) {
    // 上午盘（9:00 ~ 11:30）
    session = 'day';
    description = '日盘交易中(上午)';
  } else if (hour >= 13 && hour < 15) {
    // 下午盘（13:00 ~ 15:00）
    session = 'day';
    description = '日盘交易中(下午)';
  } else if (hour >= 15 && hour < 20) {
    // 收盘后到夜盘前
    session = 'after_hours';
    description = '盘后休整';
  } else {
    // 其他（凌晨2:30~9:00之间）
    session = 'pre_market';
    description = '盘前';
  }

  return { session, description, isTradingDay };
}

/** 格式化当前时间 */
export function formatNow(): string {
  const now = new Date();
  return now.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');
}

/** 获取今日日期 YYYY-MM-DD（按 Asia/Shanghai 日历日，不受运行机器时区影响） */
export function todayDate(now: Date = new Date()): string {
  const { year, month, day } = getShanghaiParts(now);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** 日历日加减（按 Asia/Shanghai 日历，dateStr 为 YYYY-MM-DD） */
export function addCalendarDays(dateStr: string, delta: number): string {
  const base = new Date(`${dateStr}T12:00:00+08:00`);
  base.setDate(base.getDate() + delta);
  return todayDate(base);
}
