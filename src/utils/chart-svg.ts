// 简易 SVG 折线图 — 权益曲线可视化

export interface ChartSeries {
  label: string;
  color: string;
  values: number[];
}

export interface LineChartOptions {
  width?: number;
  height?: number;
  padding?: number;
}

/** 双序列折线图 SVG（策略 vs 基准净值） */
export function renderLineChartSvg(
  labels: string[],
  series: ChartSeries[],
  options: LineChartOptions = {},
): string {
  const width = options.width ?? 640;
  const height = options.height ?? 220;
  const pad = options.padding ?? 36;

  if (labels.length === 0 || series.every(s => s.values.length === 0)) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><text x="50%" y="50%" text-anchor="middle" fill="#64748b" font-size="12">暂无曲线数据</text></svg>`;
  }

  const allVals = series.flatMap(s => s.values);
  const minY = Math.min(...allVals, 95);
  const maxY = Math.max(...allVals, 105);
  const rangeY = maxY - minY || 1;

  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const n = labels.length;

  const toX = (i: number) => pad + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const toY = (v: number) => pad + innerH - ((v - minY) / rangeY) * innerH;

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const y = pad + innerH * (1 - t);
    const val = minY + rangeY * t;
    return `<line x1="${pad}" y1="${y}" x2="${width - pad}" y2="${y}" stroke="#1e293b" stroke-width="1"/>
      <text x="${pad - 6}" y="${y + 4}" text-anchor="end" fill="#64748b" font-size="10">${val.toFixed(0)}</text>`;
  }).join('');

  const paths = series.map(s => {
    const pts = s.values.map((v, i) => `${toX(i)},${toY(v)}`).join(' ');
    const lastY = toY(s.values[s.values.length - 1] ?? 100);
    return `<polyline fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>
      <text x="${width - pad}" y="${lastY - 6}" text-anchor="end" fill="${s.color}" font-size="11">${s.label}</text>`;
  }).join('');

  const xLabels = labels.length <= 8
    ? labels.map((lb, i) => `<text x="${toX(i)}" y="${height - 10}" text-anchor="middle" fill="#64748b" font-size="9">${lb.slice(5)}</text>`).join('')
    : [0, Math.floor(n / 2), n - 1].map(i => `<text x="${toX(i)}" y="${height - 10}" text-anchor="middle" fill="#64748b" font-size="9">${labels[i].slice(5)}</text>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="权益曲线">
  <rect width="100%" height="100%" fill="#0f172a" rx="8"/>
  ${gridLines}
  ${paths}
  ${xLabels}
</svg>`;
}

/** 从权益曲线点生成图表 SVG */
export function renderEquityCurveSvg(
  points: Array<{ date: string; cumulativeStrategy: number; cumulativeBenchmark: number }>,
  maxPoints = 40,
): string {
  const slice = points.length > maxPoints ? points.slice(-maxPoints) : points;
  return renderLineChartSvg(
    slice.map(p => p.date),
    [
      { label: '策略', color: '#f59e0b', values: slice.map(p => p.cumulativeStrategy) },
      { label: '基准', color: '#60a5fa', values: slice.map(p => p.cumulativeBenchmark) },
    ],
  );
}
