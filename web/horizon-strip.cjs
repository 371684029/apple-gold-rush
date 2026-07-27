/**
 * 三期决策条：短期（5 日）/ 中期（1～3 个月）/ 长期（1/3/5 年）一屏并排。
 *
 * 此前网页要回答「今天买不买、这一轮要不要调仓、长期还配不配」，
 * 得分别翻首屏面板、正文中段、以及默认折叠的长期小节。
 * 这里把三档统一抽出来放到文章最顶部，一眼看完再决定要不要细读。
 *
 * 纯函数，供 server.cjs 与单测共用。
 */

'use strict';

const { extractScore } = require('./report-extract.cjs');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function dirMeta(direction) {
  if (direction === 'bullish') return { label: '偏多', cls: 'hz-bull', icon: '📈' };
  if (direction === 'bearish') return { label: '偏空', cls: 'hz-bear', icon: '📉' };
  return { label: '中性', cls: 'hz-flat', icon: '➡️' };
}

function dirFromLabel(text) {
  const t = String(text || '');
  if (t.includes('偏多') || t.includes('看多')) return 'bullish';
  if (t.includes('偏空') || t.includes('看空')) return 'bearish';
  return 'neutral';
}

/** 取指定标题下的整段（到下一个同级标题为止） */
function sectionOf(md, titlePattern) {
  const re = new RegExp(`^##\\s*${titlePattern}[^\\n]*$`, 'm');
  const m = re.exec(md);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = md.slice(start);
  const next = rest.search(/^##\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** 短期：综合分 + 方向 + 仓位% */
function extractShortTerm(md) {
  const score = extractScore(md);
  if (!score) return null;

  const posSection = sectionOf(md, '📦\\s*当前仓位推荐');
  let positionPct = null;
  let positionLabel = null;
  if (posSection) {
    const pm = posSection.match(/相对计划仓\s*\*{0,2}(\d+)%/);
    if (pm) positionPct = parseInt(pm[1], 10);
    const lm = posSection.match(/>\s*[^*\n]*\*\*([^*]+)\*\*\s*·/);
    if (lm) positionLabel = lm[1].trim();
  }

  return {
    horizon: 'short',
    title: '短期',
    subtitle: '约 5 个交易日',
    direction: score.direction,
    score: score.score,
    band: score.low != null && score.high != null ? `${score.low}–${score.high}` : null,
    positionPct,
    positionLabel,
  };
}

/**
 * 解析 Markdown 表格为 { 表头名: 单元格 } 的行数组。
 *
 * 按列序号取值会在版式演进时错位：2026-07-14 的长期表没有「配置档位」列，
 * 固定取第 6 列会把「名义回报区间」当成配置档位显示。
 */
function parseTable(section) {
  const lines = String(section).split('\n').map(l => l.trim());
  const headerIdx = lines.findIndex(l => l.startsWith('|') && l.includes('期限'));
  if (headerIdx === -1) return [];

  const cells = l => l.split('|').slice(1, -1).map(c => c.trim());
  const headers = cells(lines[headerIdx]);
  const rows = [];

  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    const vals = cells(line);
    if (vals.length < 2) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] ?? ''; });
    rows.push(row);
  }
  return rows;
}

/** 按候选表头名取第一个存在的列 */
function pick(row, names) {
  for (const n of names) {
    if (row[n] != null && row[n] !== '') return row[n];
  }
  return null;
}

/** 中期：1 个月 / 3 个月两行表格 */
function extractMidTerm(md) {
  const section = sectionOf(md, '🧭\\s*中期方向预期');
  if (!section) return null;

  const rows = parseTable(section)
    .filter(r => /个月/.test(r['期限'] || ''))
    .map(r => ({
      label: r['期限'],
      direction: dirFromLabel(pick(r, ['方向'])),
      score: parseInt(pick(r, ['强度']) || '50', 10),
      confidence: pick(r, ['置信', '置信度']) || null,
      stance: pick(r, ['操作倾向']) || null,
    }));
  if (!rows.length) return null;

  // 决策条只放一格，用 3 个月档代表「这一轮」，缺失时退回 1 个月
  const primary = rows.find(r => r.label === '3 个月') || rows[0];
  return {
    horizon: 'mid',
    title: '中期',
    subtitle: '1～3 个月',
    direction: primary.direction,
    score: primary.score,
    confidence: primary.confidence,
    stance: primary.stance,
    rows,
  };
}

/** 长期：1/3/5 年表格 */
function extractLongTerm(md) {
  const section = sectionOf(md, '🔭\\s*长期方向预期');
  if (!section) return null;

  const rows = parseTable(section)
    .filter(r => /^[135]年$/.test((r['期限'] || '').trim()))
    .map(r => ({
      label: r['期限'].trim(),
      direction: dirFromLabel(pick(r, ['方向'])),
      trend: pick(r, ['趋势']),
      score: parseInt(pick(r, ['强度']) || '50', 10),
      confidence: pick(r, ['置信', '置信度']) || null,
      // 旧版式没有「配置档位」列，此时不回落到回报区间，宁可留空
      stance: pick(r, ['配置档位']),
    }));
  if (!rows.length) return null;

  // 长期以 3 年档为代表：1 年仍受近端影响，5 年样本外推最弱
  const primary = rows.find(r => r.label === '3年') || rows[0];
  return {
    horizon: 'long',
    title: '长期',
    subtitle: '1 / 3 / 5 年',
    direction: primary.direction,
    score: primary.score,
    confidence: primary.confidence,
    stance: primary.stance,
    rows,
  };
}

/** 汇总三档，缺失的档位保留占位以免用户以为漏了 */
function buildHorizonView(md) {
  return {
    short: extractShortTerm(md),
    mid: extractMidTerm(md),
    long: extractLongTerm(md),
  };
}

function renderCell(cell, fallbackNote) {
  if (!cell) {
    return `<div class="hz-cell hz-empty">
      <div class="hz-head"><span class="hz-title">—</span></div>
      <div class="hz-note">${esc(fallbackNote)}</div>
    </div>`;
  }

  const meta = dirMeta(cell.direction);
  const bits = [];

  if (cell.horizon === 'short') {
    bits.push(`<div class="hz-score">${cell.score}<span class="hz-score-unit">/100</span></div>`);
    if (cell.band) bits.push(`<div class="hz-sub">区间 ${esc(cell.band)}</div>`);
    if (cell.positionPct != null) {
      bits.push(`<div class="hz-pos">建议仓位 <strong>${cell.positionPct}%</strong>${cell.positionLabel ? ` · ${esc(cell.positionLabel)}` : ''}</div>`);
    }
  } else {
    bits.push(`<div class="hz-score">${cell.score}<span class="hz-score-unit">/100</span></div>`);
    if (cell.stance) bits.push(`<div class="hz-pos">${esc(cell.stance)}</div>`);
    if (cell.confidence) bits.push(`<div class="hz-sub">置信 ${esc(cell.confidence)}</div>`);
  }

  return `<div class="hz-cell ${meta.cls}">
    <div class="hz-head">
      <span class="hz-title">${esc(cell.title)}</span>
      <span class="hz-span">${esc(cell.subtitle)}</span>
    </div>
    <div class="hz-dir">${meta.icon} ${meta.label}</div>
    ${bits.join('\n    ')}
  </div>`;
}

/**
 * 渲染三期决策条。三档全缺时返回空串，避免出现空壳。
 */
function renderHorizonStrip(md) {
  const view = buildHorizonView(md);
  if (!view.short && !view.mid && !view.long) return '';

  return `<section class="horizon-strip" aria-label="短中长期决策一览">
  <div class="hz-lead">先看这一行：三个时间尺度分别怎么说</div>
  <div class="hz-grid">
    ${renderCell(view.short, '短期评分未能解析')}
    ${renderCell(view.mid, '中期档尚未生成，运行 analysis 后出现')}
    ${renderCell(view.long, '长期档尚未生成')}
  </div>
  <div class="hz-foot">三档口径不同：短期看 5 个交易日方向，中期看 1～3 个月结构，长期为配置档位而非点位预测。三档不一致是常态，仓位以短期那一格为准。</div>
</section>`;
}

module.exports = {
  buildHorizonView,
  extractShortTerm,
  extractMidTerm,
  extractLongTerm,
  renderHorizonStrip,
};
