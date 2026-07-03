import { describe, it, expect } from 'vitest';
import { listMissingLondonDates, normalizeHistoryRows } from '../src/utils/history-backfill';
import type { GoldPricesRepo } from '../src/db/gold-prices';

function mockRepo(dates: Record<string, number | null>): GoldPricesRepo {
  return {
    getByDate: (date: string) => {
      const londonClose = dates[date];
      return londonClose != null ? { date, londonClose } : undefined;
    },
  } as unknown as GoldPricesRepo;
}

describe('listMissingLondonDates', () => {
  it('列出缺失 london_close 的日期', () => {
    const missing = listMissingLondonDates(
      mockRepo({ '2026-06-01': 2000, '2026-06-03': 2010 }),
      3,
      '2026-06-03',
    );
    expect(missing).toEqual(['2026-06-02']);
  });
});

describe('normalizeHistoryRows', () => {
  it('过滤非法行并去重', () => {
    const allowed = new Set(['2026-06-01', '2026-06-02']);
    const rows = normalizeHistoryRows([
      { date: '2026-06-01', londonClose: 2000 },
      { date: '2026-06-01', londonClose: 1999 },
      { date: '2026-06-02', londonClose: -1 },
      { date: '2026-06-03', londonClose: 2010 },
    ], allowed);
    expect(rows).toEqual([{ date: '2026-06-01', londonClose: 2000, shanghaiClose: null }]);
  });
});
