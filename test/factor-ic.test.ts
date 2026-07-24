import { describe, it, expect } from 'vitest';
import { computeFactorIc, formatFactorIcConsole } from '../src/utils/factor-ic.js';
import type { AnalysisReportRow } from '../src/db/reports.js';
import type { GoldPricesRepo } from '../src/db/gold-prices.js';

function makeReportJson(factors: Record<string, number>): string {
  const quantFactors: Record<string, { name: string; normalizedScore: number }> = {};
  for (const [k, v] of Object.entries(factors)) {
    quantFactors[k] = { name: k, normalizedScore: v };
  }
  return JSON.stringify({
    overall: { score: 50, quantScore: 50, quantFactors },
  });
}

describe('computeFactorIc', () => {
  it('对单调因子给出正向 IC', () => {
    const reports: AnalysisReportRow[] = [];
    const closesByDate = new Map<string, number>();
    let px = 2000;
    for (let i = 0; i < 20; i++) {
      const date = `2026-06-${String(i + 1).padStart(2, '0')}`;
      // 因子分越高 → 后续收益越好
      const score = 30 + i * 2;
      reports.push({
        id: i + 1,
        date,
        horizon: 'all',
        reportJson: makeReportJson({ trend: score, rsi: 50 }),
        overallScore: 50,
        quantScore: score,
        direction: 'neutral',
        createdAt: date,
      } as AnalysisReportRow);
      closesByDate.set(date, px);
      px += 5 + i; // 后期涨幅更大
    }
    // 后推收益所需的未来价
    for (let i = 20; i < 30; i++) {
      const date = `2026-06-${String(i + 1).padStart(2, '0')}`;
      closesByDate.set(date, px);
      px += 8;
    }

    const prices = {
      getAfter(date: string, limit: number) {
        const keys = [...closesByDate.keys()].sort();
        const idx = keys.indexOf(date);
        if (idx < 0) return [];
        return keys.slice(idx + 1, idx + 1 + limit).map(d => ({
          date: d,
          londonClose: closesByDate.get(d)!,
        }));
      },
    } as unknown as GoldPricesRepo;

    const ic = computeFactorIc(reports, prices, { horizonDays: 5, minSample: 5 });
    expect(ic.rows.length).toBeGreaterThan(0);
    const trend = ic.rows.find(r => r.key === 'trend');
    expect(trend?.ic).not.toBeNull();
    expect((trend?.ic ?? 0)).toBeGreaterThan(0.2);
    expect(formatFactorIcConsole(ic)).toContain('因子 IC');
  });

  it('无 quantFactors 时返回空摘要', () => {
    const reports: AnalysisReportRow[] = [{
      id: 1,
      date: '2026-07-01',
      horizon: 'all',
      reportJson: JSON.stringify({ overall: { score: 50 } }),
      overallScore: 50,
      quantScore: null,
      direction: 'neutral',
      createdAt: '2026-07-01',
    } as AnalysisReportRow];
    const prices = { getAfter: () => [] } as unknown as GoldPricesRepo;
    const ic = computeFactorIc(reports, prices);
    expect(ic.rows).toHaveLength(0);
    expect(ic.summary).toMatch(/暂无/);
  });
});
