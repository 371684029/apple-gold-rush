import { describe, it, expect } from 'vitest';
import { renderEquityCurveSvg, renderLineChartSvg } from '../src/utils/chart-svg';

describe('renderLineChartSvg', () => {
  it('无数据时返回占位 SVG', () => {
    const svg = renderLineChartSvg([], []);
    expect(svg).toContain('暂无曲线数据');
    expect(svg).toContain('<svg');
  });

  it('双序列折线包含标签与坐标', () => {
    const svg = renderLineChartSvg(
      ['2026-06-01', '2026-06-02'],
      [
        { label: '策略', color: '#f59e0b', values: [100, 102] },
        { label: '基准', color: '#60a5fa', values: [100, 101] },
      ],
    );
    expect(svg).toContain('polyline');
    expect(svg).toContain('策略');
    expect(svg).toContain('基准');
  });
});

describe('renderEquityCurveSvg', () => {
  it('从权益点生成策略/基准曲线', () => {
    const svg = renderEquityCurveSvg([
      { date: '2026-06-01', cumulativeStrategy: 100, cumulativeBenchmark: 100 },
      { date: '2026-06-02', cumulativeStrategy: 103, cumulativeBenchmark: 101 },
    ]);
    expect(svg).toContain('权益曲线');
    expect(svg).toContain('#f59e0b');
    expect(svg).toContain('#60a5fa');
  });
});
