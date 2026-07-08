#!/usr/bin/env node
// GoldRush Docs Server — 展示 docs/ 下的分析报告，带评分可视化、搜索过滤

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = parseInt(process.env.PORT || '80', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DOCS_DIR = path.resolve(__dirname, 'docs');
const DOCS_ROOT = DOCS_DIR + path.sep;

/** Markdown 渲染后 DOMPurify 选项（允许 Tearsheet 内嵌 SVG） */
const MARKDOWN_PURIFY_OPTS = {
  USE_PROFILES: { html: true, svg: true },
  ADD_ATTR: ['xmlns', 'viewBox', 'role', 'aria-label'],
};

// ===== 评分提取 =====

/** 从 Markdown 中提取评分和方向 */
function extractScore(md) {
  // 匹配 "综合评分：**68/100**（📈 偏多）" 及变体
  const m = md.match(/综合评分[：:]\s*\*{0,2}(\d+)\/100\*{0,2}[\s（(]*([^）)]*)[）)]?/);
  if (!m) return null;
  const score = parseInt(m[1], 10);
  const dirText = m[2] || '';
  let direction = 'neutral';
  if (dirText.includes('多') || dirText.includes('涨')) direction = 'bullish';
  else if (dirText.includes('空') || dirText.includes('跌')) direction = 'bearish';
  return { score, direction };
}

/** 提取四维度评分 */
function extractDimensionScores(md) {
  const dims = [];
  const pattern = /(技术面|基本面|情绪面|基金面)\D*?(\d+)\/100\D*?([^(（]+)/g;
  let m;
  while ((m = pattern.exec(md)) !== null) {
    dims.push({ name: m[1], score: parseInt(m[2], 10) });
  }
  return dims;
}

/** 提取评分构成表格（新格式 Markdown） */
function extractScoreBreakdown(md) {
  const idx = md.indexOf('## 📊 评分构成');
  if (idx < 0) return null;
  const slice = md.slice(idx, idx + 2000);
  const rows = [];
  for (const line of slice.split('\n')) {
    if (!line.startsWith('|') || line.includes('---') || line.includes('步骤')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    rows.push({
      step: cells[0].replace(/\*\*/g, ''),
      detail: cells[1],
      delta: cells[2].replace(/\*\*/g, ''),
      total: cells[3].replace(/\*\*/g, ''),
    });
  }
  return rows.length ? rows : null;
}

/** 提取速览信息（基准情景 + 短期操作） */
function extractQuickGlance(md) {
  const glance = { baseAction: '', shortAction: '', baseProb: '', macroLabel: '' };
  const macro = extractMacroRegime(md);
  if (macro) glance.macroLabel = macro.label;
  const baseRow = md.match(/\| 基准 \| ([^|]+) \| ([^|]+) \| ([^|]+)/);
  if (baseRow) {
    glance.baseProb = baseRow[1].trim();
    glance.baseAction = baseRow[3].trim().slice(0, 80);
  }
  const shortOp = md.match(/## ⏱️ 短期策略[\s\S]*?- 操作：([^\n]+)/);
  if (shortOp) glance.shortAction = shortOp[1].trim().slice(0, 60);
  return glance;
}

/** 提取宏观阶段 */
function extractMacroRegime(md) {
  const block = md.match(/## 🌐 宏观阶段[\s\S]*?(?=\n## |\n---|\Z)/);
  if (!block) return null;
  const label = block[0].match(/\*\*([^*]+)\*\*/);
  const tag = block[0].match(/`([^`]+)`/);
  const desc = block[0].match(/\n- ([^\n]+)\n- ([^\n]+)/);
  return {
    label: label ? label[1].trim() : '',
    tag: tag ? tag[1].trim() : '',
    description: desc ? desc[2].trim() : '',
  };
}

/** 提取裁决摘要首行 */
function extractJudgeVerdict(md) {
  const block = md.match(/## ⚖️ 裁决摘要[\s\S]*?(?=\n## |\n---|\Z)/);
  if (!block) return null;
  const line = block[0].match(/^- (.+)$/m);
  return line ? line[1].trim() : null;
}

/** 提取历史相似日（最多 3 条） */
function extractSimilarDays(md) {
  const idx = md.indexOf('## 📜 历史相似日');
  if (idx < 0) return null;
  const slice = md.slice(idx, idx + 1500);
  const rows = [];
  for (const line of slice.split('\n')) {
    if (!line.startsWith('|') || line.includes('---') || line.includes('日期')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    rows.push({ date: cells[0], similarity: cells[1], score: cells[2], ret: cells[3] });
  }
  return rows.length ? rows.slice(0, 3) : null;
}

/** 提取数据置信度 */
function extractDataConfidence(md) {
  const m = md.match(/数据置信度[：:]\s*(\d+)%/);
  return m ? parseInt(m[1], 10) : null;
}

/** 提取校准参考 */
function extractCalibration(md) {
  const m = md.match(/校准参考[：:]\s*([^\n]+)/);
  if (!m) return null;
  const text = m[1];
  const range = text.match(/([\d]+-[\d]+)\s*区间/);
  const acc = text.match(/(?:准确率|涨概率)\s*(\d+)%/);
  const bias = text.match(/（([^，)]+)/);
  const sample = text.match(/样本\s*(\d+)/);
  return {
    range: range ? range[1] : '',
    accuracy: acc ? parseInt(acc[1], 10) : null,
    bias: bias ? bias[1].trim() : '',
    sample: sample ? parseInt(sample[1], 10) : null,
    raw: text.trim(),
  };
}

/** 提取三情景（概率 + 操作建议摘要） */
function extractScenarios(md) {
  const names = [
    { key: '基准', cls: 'base', icon: '⚖️' },
    { key: '上行', cls: 'up', icon: '📈' },
    { key: '下行', cls: 'down', icon: '📉' },
  ];
  const out = [];
  for (const { key, cls, icon } of names) {
    const row = md.match(new RegExp(`\\| ${key} \\| ([^|]+) \\| ([^|]+) \\| ([^|]+)`));
    if (!row) continue;
    const prob = parseInt(String(row[1]).replace(/[^\d]/g, ''), 10);
    out.push({
      name: key,
      cls,
      icon,
      probability: Number.isFinite(prob) ? prob : 0,
      summary: row[2].trim().slice(0, 100),
      action: row[3].trim().slice(0, 72),
    });
  }
  return out.length === 3 ? out : null;
}

/** 提取定投/操作策略（人话） */
function extractStrategies(md) {
  const shortOp = md.match(/## ⏱️ 短期策略[\s\S]*?- 操作：([^\n]+)/);
  const midDca = md.match(/定投建议：(\w+)/);
  const midPos = md.match(/仓位调整：(\w+)/);
  const dcaMap = { continue: '继续定投', increase: '加码定投', pause: '暂停定投' };
  const posMap = { add: '加仓', reduce: '减仓', hold: '维持仓位' };
  return {
    short: shortOp ? shortOp[1].trim().slice(0, 100) : '',
    dca: midDca ? (dcaMap[midDca[1]] || midDca[1]) : '',
    position: midPos ? (posMap[midPos[1]] || midPos[1]) : '',
  };
}

/** 分数 → 通俗结论（支付宝定投视角） */
function plainAdvice(score, direction) {
  const s = score ?? 50;
  const d = direction || (s >= 58 ? 'bullish' : s <= 42 ? 'bearish' : 'neutral');
  if (d === 'bullish' || s >= 58) {
    return {
      label: '偏多',
      headline: '黄金短期动能偏强',
      action: '维持定投；急跌可小幅加码，高位不追',
      color: '#22c55e',
      bg: '#22c55e18',
      emoji: '📈',
    };
  }
  if (d === 'bearish' || s <= 42) {
    return {
      label: '偏空',
      headline: '下行风险大于反弹空间',
      action: '放慢定投或暂停加码，等评分/价格回落',
      color: '#ef4444',
      bg: '#ef444418',
      emoji: '📉',
    };
  }
  return {
    label: '中性',
    headline: '震荡整理，方向未明',
    action: '维持基础定投，按日历执行、少择时',
    color: '#f59e0b',
    bg: '#f59e0b18',
    emoji: '➡️',
  };
}

/** 历史相似日汇总（说服力） */
function summarizeSimilarDays(similar) {
  if (!similar || !similar.length) return null;
  const rets = similar.map(s => parseFloat(String(s.ret).replace(/[^\d.-]/g, ''))).filter(n => Number.isFinite(n));
  if (!rets.length) return null;
  const up = rets.filter(r => r > 0).length;
  const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
  return {
    up,
    total: rets.length,
    upRate: Math.round((up / rets.length) * 100),
    avgReturn: Math.round(avg * 100) / 100,
  };
}

/** 渲染 Markdown 前去掉已在仪表盘展示的冗余块 */
function stripDashboardDuplicates(md) {
  return md
    .replace(/## 📊 评分构成[\s\S]*?(?=\n## )/, '')
    .replace(/## 综合研判[\s\S]*?(?=\n## )/, '');
}

/** 预测仪表盘（文章页顶部） */
function renderPredictionDashboard(meta) {
  const { scoreInfo, advice, confidence, calibration, scenarios, strategies, similarSummary, macro } = meta;
  if (!scoreInfo) return '';

  const score = scoreInfo.score;
  const confPct = confidence != null ? confidence : '—';
  const confClass = confidence >= 70 ? 'good' : confidence >= 50 ? 'mid' : 'low';

  const trustParts = [];
  if (calibration?.accuracy != null) {
    trustParts.push(`同分段历史 5 日上涨概率 <strong>${calibration.accuracy}%</strong>（${esc(calibration.range)}，样本 ${calibration.sample ?? '—'}）`);
  }
  if (similarSummary) {
    trustParts.push(`历史相似日 ${similarSummary.total} 次中 ${similarSummary.upRate}% 上涨，平均 ${similarSummary.avgReturn >= 0 ? '+' : ''}${similarSummary.avgReturn}%`);
  }
  const trustHtml = trustParts.length
    ? `<div class="pred-trust"><span class="pred-trust-icon">🎯</span><div class="pred-trust-body">${trustParts.join('<br>')}</div></div>`
    : `<div class="pred-trust pred-trust-muted"><span class="pred-trust-icon">ℹ️</span><div>样本积累中，结论供参考，请结合定投纪律</div></div>`;

  const scenarioHtml = scenarios ? scenarios.map(s => `
    <div class="sc-card sc-${s.cls}">
      <div class="sc-head"><span>${s.icon} ${esc(s.name)}</span><span class="sc-pct">${s.probability}%</span></div>
      <div class="sc-bar"><div class="sc-fill" style="width:${s.probability}%"></div></div>
      <div class="sc-action">${esc(s.action || s.summary)}</div>
    </div>`).join('') : '';

  return `<section class="pred-dashboard" aria-label="预测结论">
    <div class="pred-hero" style="--pred-color:${advice.color};--pred-bg:${advice.bg}">
      <div class="pred-score-col">
        <div class="pred-score-num">${score}</div>
        <div class="pred-score-sub">综合分 / 100</div>
        <div class="pred-score-meter"><div class="pred-score-fill" style="width:${score}%;background:${advice.color}"></div></div>
      </div>
      <div class="pred-verdict-col">
        <div class="pred-emoji">${advice.emoji}</div>
        <h2 class="pred-headline">${esc(advice.headline)}</h2>
        <p class="pred-tag">${advice.label} · ${scoreInfo.direction === 'bullish' ? '短期动能偏强' : scoreInfo.direction === 'bearish' ? '需防回调' : '方向待确认'}</p>
        <div class="pred-action-box">
          <span class="pred-action-label">💡 定投建议</span>
          <p class="pred-action-text">${esc(advice.action)}</p>
        </div>
        ${macro ? `<p class="pred-macro">🌐 ${esc(macro.label)} — ${esc(macro.description.slice(0, 48))}${macro.description.length > 48 ? '…' : ''}</p>` : ''}
      </div>
      <div class="pred-meta-col">
        <div class="pred-pill conf-${confClass}">数据置信 ${confPct}%</div>
        ${strategies.dca ? `<div class="pred-pill">中长期 ${esc(strategies.dca)}</div>` : ''}
        ${strategies.position ? `<div class="pred-pill">仓位 ${esc(strategies.position)}</div>` : ''}
      </div>
    </div>
    ${trustHtml}
    ${scenarioHtml ? `<div class="pred-scenarios"><div class="pred-section-title">未来 1–2 周怎么走？（三情景概率）</div><div class="sc-grid">${scenarioHtml}</div></div>` : ''}
    ${strategies.short ? `<div class="pred-short-tip"><span>⏱️ 短期</span>${esc(strategies.short)}</div>` : ''}
  </section>`;
}

/** 列表页通俗结论条 */
function renderCardVerdict(score, direction) {
  const a = plainAdvice(score, direction);
  return `<span class="verdict-chip" style="color:${a.color};background:${a.bg};border-color:${a.color}33">${a.emoji} ${a.label} · ${esc(a.action.slice(0, 28))}${a.action.length > 28 ? '…' : ''}</span>`;
}

/** 渲染评分构成瀑布（侧边栏） */
function renderScoreWaterfall(breakdown) {
  if (!breakdown || !breakdown.length) return '';
  return breakdown.map(row => {
    const isFinal = row.step.includes('最终');
    const isSubtotal = row.step.includes('均分') || row.step.includes('反驳');
    let deltaClass = 'neutral';
    if (row.delta.startsWith('+')) deltaClass = 'up';
    else if (row.delta.startsWith('-') || row.delta.startsWith('−')) deltaClass = 'down';
    return `<div class="wf-row ${isFinal ? 'wf-final' : isSubtotal ? 'wf-sub' : ''}">
      <div class="wf-step">${esc(row.step)}</div>
      <div class="wf-detail">${esc(row.detail)}</div>
      <div class="wf-meta">
        ${row.delta !== '—' ? `<span class="wf-delta ${deltaClass}">${esc(row.delta)}</span>` : ''}
        ${row.total !== '—' ? `<span class="wf-total">${esc(row.total)}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

/** HTML 转义 */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== 文件信息封装 =====

function getFileInfos(files) {
  return files.map(f => {
    const fp = path.join(DOCS_DIR, f);
    const stats = fs.statSync(fp);
    const md = fs.readFileSync(fp, 'utf-8');
    const scoreInfo = extractScore(md);
    const dims = extractDimensionScores(md);
    const dateLabel = f.replace('goldrush-analysis-', '').replace('.md', '');
    return {
      filename: f,
      dateLabel,
      mtime: stats.mtime,
      sizeKB: (stats.size / 1024).toFixed(1),
      score: scoreInfo?.score ?? null,
      direction: scoreInfo?.direction ?? null,
      dims,
      mdLength: md.length,
      glance: extractQuickGlance(md),
      breakdown: extractScoreBreakdown(md),
      macro: extractMacroRegime(md),
      judge: extractJudgeVerdict(md),
      similar: extractSimilarDays(md),
      similarSummary: summarizeSimilarDays(extractSimilarDays(md)),
      calibration: extractCalibration(md),
      confidence: extractDataConfidence(md),
      scenarios: extractScenarios(md),
      strategies: extractStrategies(md),
      advice: scoreInfo ? plainAdvice(scoreInfo.score, scoreInfo.direction) : null,
    };
  });
}

// ===== 评分徽章 =====

function scoreBadge(score) {
  if (score == null) return '';
  let color, label;
  if (score >= 75) { color = '#22c55e'; label = '偏多'; }
  else if (score >= 55) { color = '#f59e0b'; label = '中性'; }
  else { color = '#ef4444'; label = '偏空'; }
  return `<span class="s-badge" style="background:${color}22;color:${color};border-color:${color}44">${score}<span class="s-label">${label}</span></span>`;
}

// ===== 文件列表页（含搜索过滤排序） =====

function renderIndex(fileInfos) {
  const latest = fileInfos[0] ?? null;
  const rest = fileInfos.slice(1);

  const heroHtml = latest ? `<a href="/${latest.filename}" class="hero-card dir-${latest.direction || 'neutral'}">
    <div class="hero-badge">最新研判</div>
    <div class="hero-left">${scoreBadge(latest.score)}</div>
    <div class="hero-body">
      <div class="hero-date">${esc(latest.dateLabel)}</div>
      ${latest.advice ? `<div class="hero-verdict">${latest.advice.emoji} ${esc(latest.advice.headline)}</div>` : '<div class="hero-title">黄金投资日报</div>'}
      ${latest.advice ? `<div class="hero-action">💡 ${esc(latest.advice.action)}</div>` : ''}
      ${latest.scenarios ? `<div class="hero-scenarios">${latest.scenarios.map(s => `<span class="sc-mini sc-${s.cls}">${s.icon}${s.probability}%</span>`).join('')}</div>` : ''}
      ${latest.similarSummary ? `<div class="hero-proof">📜 相似日 ${latest.similarSummary.upRate}% 上涨 · 均 ${latest.similarSummary.avgReturn >= 0 ? '+' : ''}${latest.similarSummary.avgReturn}%</div>` : ''}
      <div class="hero-dims">${latest.dims.map(d => `<span class="dim-tag">${d.name.slice(0, 2)} ${d.score}</span>`).join('')}</div>
    </div>
    <div class="hero-arrow">→</div>
  </a>` : '';

  const cardRows = rest.map(info => {
    const mtimeStr = info.mtime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<a href="/${info.filename}" class="report-card dir-${info.direction || 'neutral'}" data-search="${esc(info.filename + ' ' + info.dateLabel + ' ' + (info.score ?? '') + ' ' + (info.advice?.label ?? ''))}">
      <div class="rc-score">${scoreBadge(info.score)}</div>
      <div class="rc-body">
        <div class="rc-date">${info.dateLabel}</div>
        ${info.advice ? `<div class="rc-verdict">${renderCardVerdict(info.score, info.direction)}</div>` : `<div class="rc-snippet muted">${esc(info.filename)}</div>`}
        ${info.scenarios ? `<div class="rc-scenarios">${info.scenarios.map(s => `<span class="sc-mini sc-${s.cls}">${s.probability}%</span>`).join('')}</div>` : ''}
        <div class="rc-meta">${info.dims.map(d => `<span class="dim-tag">${d.name.slice(0, 1)}${d.score}</span>`).join('')} · ${mtimeStr}</div>
      </div>
    </a>`;
  }).join('\n');

  // 统计
  const total = fileInfos.length;
  const bullish = fileInfos.filter(i => i.direction === 'bullish').length;
  const bearish = fileInfos.filter(i => i.direction === 'bearish').length;
  const neutral = fileInfos.filter(i => i.direction === 'neutral' || i.direction === null).length;
  const avgScore = total > 0 ? Math.round(fileInfos.reduce((s, i) => s + (i.score ?? 50), 0) / total) : '—';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🥇 GoldRush 分析报告</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif;
      background: linear-gradient(135deg, #0b1120 0%, #0f172a 50%, #0a0f1a 100%);
      color: #e2e8f0;
      min-height: 100vh;
    }
    .container { max-width: 960px; margin: 0 auto; padding: 32px 20px 48px; }

    .hero-verdict { font-size: 1.05rem; font-weight: 700; color: #f1f5f9; margin: 6px 0 8px; line-height: 1.4; }
    .hero-scenarios { display: flex; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
    .hero-proof { font-size: 0.78rem; color: #86efac; margin-bottom: 6px; }
    .sc-mini {
      font-size: 0.72rem; font-weight: 700; padding: 3px 8px; border-radius: 6px;
      background: #1a2332; border: 1px solid #334155;
    }
    .sc-mini.sc-base { color: #94a3b8; }
    .sc-mini.sc-up { color: #22c55e; border-color: #22c55e33; }
    .sc-mini.sc-down { color: #ef4444; border-color: #ef444433; }
    .rc-verdict { margin: 6px 0; }
    .rc-scenarios { display: flex; gap: 6px; margin: 4px 0; }
    .verdict-chip {
      display: inline-block; font-size: 0.78rem; padding: 4px 10px;
      border-radius: 8px; border: 1px solid; line-height: 1.35;
    }

    /* Hero — 最新报告 */
    .hero-card {
      display: flex; align-items: center; gap: 20px;
      background: linear-gradient(135deg, #1a2744 0%, #1e293b 60%, #172033 100%);
      border: 1px solid #334155; border-radius: 18px;
      padding: 24px 28px; margin-bottom: 28px;
      text-decoration: none; color: inherit;
      transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
      position: relative; overflow: hidden;
    }
    .hero-card::before {
      content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px;
      background: linear-gradient(180deg, #f59e0b, #d97706);
    }
    .hero-card.dir-bullish::before { background: linear-gradient(180deg, #22c55e, #16a34a); }
    .hero-card.dir-bearish::before { background: linear-gradient(180deg, #ef4444, #dc2626); }
    .hero-card:hover { transform: translateY(-3px); border-color: #f59e0b55; box-shadow: 0 12px 40px #00000044; }
    .hero-badge {
      position: absolute; top: 12px; right: 16px;
      font-size: 0.65rem; font-weight: 700; letter-spacing: 1px;
      color: #fbbf24; background: #f59e0b18; border: 1px solid #f59e0b33;
      padding: 3px 10px; border-radius: 20px;
    }
    .hero-left { flex-shrink: 0; }
    .hero-body { flex: 1; min-width: 0; }
    .hero-date { font-size: 0.78rem; color: #64748b; letter-spacing: 0.5px; }
    .hero-title { font-size: 1.25rem; font-weight: 700; color: #f1f5f9; margin: 4px 0 8px; }
    .hero-action { font-size: 0.88rem; color: #cbd5e1; line-height: 1.5; margin-bottom: 4px; }
    .hero-macro { font-size: 0.82rem; color: #93c5fd; margin-bottom: 6px; font-weight: 500; }
    .hero-short { font-size: 0.82rem; color: #94a3b8; }
    .hero-dims { margin-top: 10px; }
    .hero-arrow { font-size: 1.4rem; color: #475569; flex-shrink: 0; }

    /* 报告卡片列表 */
    .card-grid { display: flex; flex-direction: column; gap: 10px; }
    .report-card {
      display: flex; align-items: flex-start; gap: 14px;
      background: #1e293b; border: 1px solid #2d3a4e; border-radius: 12px;
      padding: 14px 16px; text-decoration: none; color: inherit;
      transition: background 0.15s, border-color 0.15s;
      border-left: 3px solid #475569;
    }
    .report-card.dir-bullish { border-left-color: #22c55e; }
    .report-card.dir-bearish { border-left-color: #ef4444; }
    .report-card.dir-neutral { border-left-color: #f59e0b; }
    .report-card:hover { background: #243045; border-color: #475569; }
    .report-card.hidden { display: none; }
    .rc-score { flex-shrink: 0; }
    .rc-body { flex: 1; min-width: 0; }
    .rc-date { font-weight: 600; color: #e2e8f0; font-size: 0.95rem; }
    .rc-snippet { font-size: 0.82rem; color: #94a3b8; margin-top: 4px; line-height: 1.45; }
    .rc-snippet.muted { color: #64748b; font-family: monospace; font-size: 0.75rem; }
    .rc-meta { font-size: 0.72rem; color: #64748b; margin-top: 6px; }

    /* Header */
    header {
      text-align: center;
      padding: 32px 0 40px;
      position: relative;
    }
    header::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 50%;
      transform: translateX(-50%);
      width: 80px;
      height: 2px;
      background: linear-gradient(90deg, transparent, #f59e0b, transparent);
    }
    header h1 {
      font-size: 2rem;
      background: linear-gradient(135deg, #fbbf24, #d97706);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      font-weight: 800;
      letter-spacing: 1px;
    }
    header .subtitle {
      color: #64748b;
      margin-top: 10px;
      font-size: 0.9rem;
      letter-spacing: 2px;
    }

    /* Stats */
    .stats {
      display: flex;
      justify-content: center;
      gap: 16px;
      margin: 36px 0 28px;
      flex-wrap: wrap;
    }
    .stat-card {
      background: linear-gradient(135deg, #1e293b, #1a2332);
      border: 1px solid #2d3a4e;
      border-radius: 14px;
      padding: 16px 24px;
      text-align: center;
      min-width: 100px;
      transition: transform 0.2s, border-color 0.2s;
    }
    .stat-card:hover { transform: translateY(-2px); border-color: #f59e0b44; }
    .stat-card .num {
      font-size: 1.5rem;
      font-weight: 700;
    }
    .stat-card .num.green { color: #22c55e; }
    .stat-card .num.yellow { color: #f59e0b; }
    .stat-card .num.red { color: #ef4444; }
    .stat-card .num.gold { color: #fbbf24; }
    .stat-card .label {
      font-size: 0.7rem;
      color: #64748b;
      margin-top: 4px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    /* Search & Sort */
    .toolbar {
      display: flex;
      gap: 12px;
      margin: 24px 0 16px;
      flex-wrap: wrap;
      align-items: center;
    }
    .search-box {
      flex: 1;
      min-width: 200px;
      background: #1e293b;
      border: 1px solid #2d3a4e;
      border-radius: 10px;
      padding: 10px 16px;
      color: #e2e8f0;
      font-size: 0.9rem;
      outline: none;
      transition: border-color 0.2s;
    }
    .search-box:focus { border-color: #f59e0b; }
    .search-box::placeholder { color: #475569; }
    .sort-btn {
      background: #1e293b;
      border: 1px solid #2d3a4e;
      border-radius: 10px;
      padding: 10px 16px;
      color: #94a3b8;
      font-size: 0.85rem;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .sort-btn:hover { border-color: #f59e0b44; color: #e2e8f0; }
    .sort-btn.active { border-color: #f59e0b; color: #fbbf24; }
    .section-label {
      font-size: 0.72rem; text-transform: uppercase; letter-spacing: 1.5px;
      color: #64748b; margin: 8px 0 12px; font-weight: 600;
    }

    /* Search & Sort */
    .s-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 12px;
      border-radius: 20px;
      font-weight: 700;
      font-size: 1.05rem;
      border: 1px solid;
      white-space: nowrap;
    }
    .s-badge .s-label {
      font-size: 0.65rem;
      font-weight: 500;
      opacity: 0.85;
    }

    .dim-tag {
      display: inline-block;
      background: #1a2332;
      border: 1px solid #2d3a4e;
      border-radius: 6px;
      padding: 2px 7px;
      font-size: 0.7rem;
      color: #94a3b8;
      margin: 1px 2px;
    }

    /* Hidden */
    .hidden { display: none !important; }

    /* Footer */
    footer {
      text-align: center;
      margin-top: 48px;
      padding: 24px 0;
      color: #475569;
      font-size: 0.78rem;
    }
    footer a { color: #64748b; text-decoration: none; }
    footer a:hover { color: #94a3b8; }

    /* Empty state */
    .empty {
      text-align: center;
      padding: 60px 20px;
      color: #64748b;
    }
    .empty .icon { font-size: 3rem; margin-bottom: 16px; }
    .empty p { font-size: 0.95rem; }
    .empty code { background: #1a2332; padding: 2px 8px; border-radius: 4px; }

    @media (max-width: 768px) {
      .container { padding: 20px 14px; }
      header h1 { font-size: 1.5rem; }
      .stats { gap: 8px; }
      .stat-card { padding: 12px 16px; min-width: 80px; }
      .hero-card { flex-direction: column; align-items: flex-start; padding: 20px; }
      .hero-arrow { display: none; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🥇 GoldRush</h1>
      <p class="subtitle">一眼看懂 · 分数 · 概率 · 定投建议</p>
    </header>

    <div class="stats">
      <div class="stat-card"><div class="num gold">${total}</div><div class="label">报告</div></div>
      ${total > 0 ? `
      <div class="stat-card"><div class="num green">${bullish}</div><div class="label">偏多</div></div>
      <div class="stat-card"><div class="num yellow">${neutral}</div><div class="label">中性</div></div>
      <div class="stat-card"><div class="num red">${bearish}</div><div class="label">偏空</div></div>
      <div class="stat-card"><div class="num gold">${avgScore}</div><div class="label">均分</div></div>
      ` : ''}
    </div>

    ${total > 0 ? `
    <div class="toolbar">
      <input type="text" class="search-box" id="search" placeholder="🔍 搜索日期、评分、操作…" oninput="filterCards()">
      <button class="sort-btn active" id="sort-date" onclick="setSort('date')">📅 日期</button>
      <button class="sort-btn" id="sort-score" onclick="setSort('score')">📊 评分</button>
    </div>
    ${heroHtml}
    ${rest.length ? `<div class="section-label">历史报告</div><div class="card-grid" id="card-grid">${cardRows}</div>` : ''}` : `<div class="empty">
      <div class="icon">📭</div>
      <p>暂无分析报告<br>运行 <code>node dist/index.js analysis --md</code> 生成第一份</p>
    </div>`}

    <footer>
      <p>报告由 <a href="/">GoldRush</a> 自动生成 · 仅供研究参考，不构成投资建议</p>
      <p style="margin-top:8px"><a href="/goldrush-digest-latest.md">📰 周期摘要</a> · <a href="/goldrush-calibration-latest.md">📊 校准 Tearsheet</a></p>
    </footer>
  </div>

  <script>
    function filterCards() {
      const q = document.getElementById('search').value.toLowerCase();
      document.querySelectorAll('.report-card').forEach(card => {
        const text = (card.getAttribute('data-search') || card.textContent || '').toLowerCase();
        card.classList.toggle('hidden', q && !text.includes(q));
      });
    }

    let sortMode = 'date';
    function setSort(mode) {
      sortMode = mode;
      document.getElementById('sort-date').classList.toggle('active', mode === 'date');
      document.getElementById('sort-score').classList.toggle('active', mode === 'score');
      doSort();
    }

    function doSort() {
      const grid = document.getElementById('card-grid');
      if (!grid) return;
      const cards = Array.from(grid.querySelectorAll('.report-card'));
      cards.sort((a, b) => {
        if (sortMode === 'date') {
          const da = a.querySelector('.rc-date')?.textContent || '';
          const db = b.querySelector('.rc-date')?.textContent || '';
          return db.localeCompare(da);
        }
        const sa = parseInt(a.querySelector('.s-badge')?.textContent) || 0;
        const sb = parseInt(b.querySelector('.s-badge')?.textContent) || 0;
        return sb - sa;
      });
      for (const c of cards) grid.appendChild(c);
    }
  </script>
</body>
</html>`;
}

// ===== Markdown 文章页模板（加入评分卡片） =====

function renderArticle(mdFilename, rawMarkdown) {
  const dateLabel = mdFilename.replace('goldrush-analysis-', '').replace('.md', '');
  const scoreInfo = extractScore(rawMarkdown);
  const dims = extractDimensionScores(rawMarkdown);
  const breakdown = extractScoreBreakdown(rawMarkdown);
  const glance = extractQuickGlance(rawMarkdown);
  const macro = extractMacroRegime(rawMarkdown);
  const judge = extractJudgeVerdict(rawMarkdown);
  const similar = extractSimilarDays(rawMarkdown);
  const similarSummary = summarizeSimilarDays(similar);
  const calibration = extractCalibration(rawMarkdown);
  const confidence = extractDataConfidence(rawMarkdown);
  const scenarios = extractScenarios(rawMarkdown);
  const strategies = extractStrategies(rawMarkdown);
  const advice = scoreInfo ? plainAdvice(scoreInfo.score, scoreInfo.direction) : null;

  const dashboardHtml = renderPredictionDashboard({
    scoreInfo, advice, confidence, calibration, scenarios, strategies, similarSummary, macro,
  });

  const displayMd = stripDashboardDuplicates(rawMarkdown);

  const scoreHtml = scoreInfo ? `<div class="score-gauge">
    <div class="sg-circle" style="background:conic-gradient(${scoreInfo.score >= 75 ? '#22c55e' : scoreInfo.score >= 55 ? '#f59e0b' : '#ef4444'} ${scoreInfo.score * 3.6}deg, #1e293b ${scoreInfo.score * 3.6}deg)">
      <div class="sg-inner">
        <div class="sg-score">${scoreInfo.score}</div>
        <div class="sg-label">/100</div>
      </div>
    </div>
    <div class="sg-direction">${scoreInfo.direction === 'bullish' ? '📈 偏多' : scoreInfo.direction === 'bearish' ? '📉 偏空' : '➡️ 中性'}</div>
  </div>` : '';

  const dimRows = dims.map(d => {
    const pct = d.score;
    let c = '#22c55e';
    if (pct < 55) c = '#ef4444';
    else if (pct < 75) c = '#f59e0b';
    return `<div class="dim-bar-row"><span class="dim-name">${d.name}</span><div class="dim-bar-bg"><div class="dim-bar-fill" style="width:${pct}%;background:${c}"></div></div><span class="dim-val">${d.score}</span></div>`;
  }).join('');

  const waterfallHtml = breakdown ? `<div class="sidebar-block">
    <div class="sb-title">评分构成</div>
    <div class="waterfall">${renderScoreWaterfall(breakdown)}</div>
  </div>` : '';

  const macroHtml = macro ? `<div class="sidebar-block macro-chip">
    <div class="sb-title">宏观阶段</div>
    <div class="macro-label">${esc(macro.label)}</div>
    <div class="macro-desc">${esc(macro.description)}</div>
  </div>` : '';

  const judgeHtml = judge ? `<div class="sidebar-block judge-box">
    <div class="sb-title">裁决摘要</div>
    <p class="judge-text">${esc(judge.slice(0, 200))}${judge.length > 200 ? '…' : ''}</p>
  </div>` : '';

  const similarHtml = similar && similar.length ? `<div class="sidebar-block">
    <div class="sb-title">历史佐证</div>
    <div class="sim-summary">${similarSummary ? `相似日 ${similarSummary.upRate}% 上涨 · 均 ${similarSummary.avgReturn >= 0 ? '+' : ''}${similarSummary.avgReturn}%` : ''}</div>
    ${similar.map(s => `<div class="sim-row"><span>${esc(s.date)}</span><span>${esc(s.similarity)}</span><span class="${parseFloat(s.ret) >= 0 ? 'up' : 'down'}">${esc(s.ret)}</span></div>`).join('')}
  </div>` : '';

  const tocItems = [];
  for (const m of displayMd.matchAll(/^## (.+)$/gm)) {
    const title = m[1].trim();
    if (title.startsWith('📊 评分构成')) continue;
    const id = 'sec-' + tocItems.length;
    tocItems.push({ title, id });
  }
  const tocHtml = tocItems.length > 1 ? `<nav class="sidebar-block toc">
    <div class="sb-title">目录</div>
    ${tocItems.map(t => `<a href="#${t.id}" class="toc-link">${esc(t.title)}</a>`).join('')}
  </nav>` : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(dateLabel)} — GoldRush 分析报告</title>
  <script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", -apple-system, sans-serif;
      background: #0b1120;
      color: #cbd5e1;
      line-height: 1.8;
    }

    /* Top navigation bar */
    .topbar {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(11, 17, 32, 0.85);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-bottom: 1px solid #1e293b;
      padding: 0 24px;
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .topbar-left { display: flex; align-items: center; gap: 12px; }
    .topbar a {
      color: #94a3b8;
      text-decoration: none;
      font-size: 0.88rem;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: color 0.2s;
    }
    .topbar a:hover { color: #f59e0b; }
    .topbar .logo {
      font-weight: 700;
      font-size: 1rem;
      color: #f59e0b;
    }
    .topbar .sep { color: #334155; font-size: 0.75rem; }
    .topbar .report-date { color: #64748b; font-size: 0.82rem; }

    /* Article layout: score sidebar + content */
    .article-layout {
      max-width: 1100px;
      margin: 0 auto;
      padding: 40px 24px 80px;
      display: flex;
      gap: 40px;
      align-items: flex-start;
    }

    /* Sidebar with score gauge */
    .sidebar {
      position: sticky;
      top: 80px;
      width: 200px;
      flex-shrink: 0;
    }
    .score-gauge { text-align: center; margin-bottom: 24px; }
    .sg-circle {
      width: 120px;
      height: 120px;
      border-radius: 50%;
      margin: 0 auto 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }
    .sg-inner {
      width: 88px;
      height: 88px;
      border-radius: 50%;
      background: #0b1120;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .sg-score { font-size: 1.8rem; font-weight: 800; color: #f1f5f9; line-height: 1; }
    .sg-label { font-size: 0.7rem; color: #64748b; }
    .sg-direction { font-size: 0.85rem; color: #94a3b8; margin-top: 4px; }

    /* Dimension bars in sidebar */
    .dim-bar-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 6px 0;
      font-size: 0.78rem;
    }
    .dim-name { width: 36px; color: #94a3b8; flex-shrink: 0; }
    .dim-bar-bg {
      flex: 1;
      height: 6px;
      background: #1e293b;
      border-radius: 3px;
      overflow: hidden;
    }
    .dim-bar-fill { height: 100%; border-radius: 3px; transition: width 0.5s; }
    .dim-val { width: 24px; text-align: right; color: #64748b; }

    /* Sidebar blocks */
    .sidebar-block { margin-top: 20px; padding-top: 16px; border-top: 1px solid #1e293b; }
    .sb-title { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 1.2px; color: #64748b; margin-bottom: 10px; font-weight: 600; }

    /* Score waterfall */
    .waterfall { display: flex; flex-direction: column; gap: 6px; }
    .wf-row {
      background: #131c2e; border: 1px solid #1e293b; border-radius: 8px;
      padding: 8px 10px; font-size: 0.72rem;
    }
    .wf-row.wf-sub { background: #1a2332; border-color: #334155; }
    .wf-row.wf-final { border-color: #f59e0b44; background: #1f2937; }
    .wf-step { font-weight: 600; color: #e2e8f0; }
    .wf-detail { color: #64748b; margin-top: 2px; font-size: 0.68rem; }
    .wf-meta { display: flex; gap: 8px; margin-top: 4px; align-items: center; }
    .wf-delta { font-weight: 700; font-size: 0.78rem; }
    .wf-delta.up { color: #22c55e; }
    .wf-delta.down { color: #ef4444; }
    .wf-delta.neutral { color: #94a3b8; }
    .wf-total { color: #fbbf24; font-weight: 700; margin-left: auto; }

    /* TOC */
    .toc { display: flex; flex-direction: column; gap: 4px; }
    .toc-link {
      color: #94a3b8; text-decoration: none; font-size: 0.78rem;
      padding: 4px 8px; border-radius: 6px; transition: background 0.15s, color 0.15s;
    }
    .toc-link:hover { background: #1e293b; color: #f59e0b; }

    .sim-row span.up { color: #22c55e; font-weight: 600; }
    .sim-row span.down { color: #ef4444; font-weight: 600; }
    .sim-summary { font-size: 0.72rem; color: #86efac; margin-bottom: 8px; line-height: 1.4; }

    /* 预测仪表盘 */
    .pred-dashboard { margin-bottom: 32px; }
    .pred-hero {
      display: grid; grid-template-columns: 120px 1fr auto; gap: 24px; align-items: start;
      background: linear-gradient(135deg, #1a2744 0%, #1e293b 100%);
      border: 1px solid #334155; border-left: 4px solid var(--pred-color, #f59e0b);
      border-radius: 16px; padding: 24px 28px;
    }
    .pred-score-num { font-size: 3rem; font-weight: 800; color: #f8fafc; line-height: 1; }
    .pred-score-sub { font-size: 0.72rem; color: #64748b; margin-top: 4px; }
    .pred-score-meter { height: 6px; background: #0f172a; border-radius: 3px; margin-top: 10px; overflow: hidden; }
    .pred-score-fill { height: 100%; border-radius: 3px; transition: width 0.6s; }
    .pred-emoji { font-size: 1.5rem; margin-bottom: 4px; }
    .pred-headline { font-size: 1.35rem; color: #f1f5f9; font-weight: 700; margin-bottom: 6px; line-height: 1.35; }
    .pred-tag { font-size: 0.82rem; color: var(--pred-color); font-weight: 600; margin-bottom: 12px; }
    .pred-action-box {
      background: var(--pred-bg); border: 1px solid var(--pred-color);
      border-radius: 10px; padding: 12px 14px;
    }
    .pred-action-label { font-size: 0.68rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
    .pred-action-text { font-size: 0.95rem; color: #e2e8f0; margin-top: 4px; font-weight: 500; line-height: 1.45; }
    .pred-macro { font-size: 0.78rem; color: #93c5fd; margin-top: 10px; }
    .pred-meta-col { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
    .pred-pill {
      font-size: 0.72rem; padding: 5px 10px; border-radius: 20px;
      background: #0f172a; border: 1px solid #334155; color: #94a3b8; white-space: nowrap;
    }
    .pred-pill.conf-good { color: #86efac; border-color: #22c55e44; }
    .pred-pill.conf-mid { color: #fcd34d; border-color: #f59e0b44; }
    .pred-pill.conf-low { color: #fca5a5; border-color: #ef444444; }
    .pred-trust {
      display: flex; gap: 12px; align-items: flex-start;
      margin-top: 14px; padding: 14px 18px;
      background: #131c2e; border: 1px solid #1e293b; border-radius: 12px;
      font-size: 0.85rem; color: #cbd5e1; line-height: 1.5;
    }
    .pred-trust-muted { color: #64748b; }
    .pred-trust-icon { font-size: 1.2rem; flex-shrink: 0; }
    .pred-trust strong { color: #fbbf24; }
    .pred-section-title { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0 12px; font-weight: 600; }
    .sc-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .sc-card {
      background: #131c2e; border: 1px solid #1e293b; border-radius: 12px; padding: 14px 16px;
    }
    .sc-card.sc-up { border-top: 3px solid #22c55e; }
    .sc-card.sc-down { border-top: 3px solid #ef4444; }
    .sc-card.sc-base { border-top: 3px solid #64748b; }
    .sc-head { display: flex; justify-content: space-between; font-size: 0.85rem; font-weight: 600; color: #e2e8f0; margin-bottom: 8px; }
    .sc-pct { font-size: 1.1rem; color: #fbbf24; }
    .sc-bar { height: 5px; background: #0f172a; border-radius: 3px; overflow: hidden; margin-bottom: 10px; }
    .sc-fill { height: 100%; background: linear-gradient(90deg, #f59e0b, #fbbf24); border-radius: 3px; }
    .sc-card.sc-up .sc-fill { background: linear-gradient(90deg, #16a34a, #22c55e); }
    .sc-card.sc-down .sc-fill { background: linear-gradient(90deg, #dc2626, #ef4444); }
    .sc-action { font-size: 0.78rem; color: #94a3b8; line-height: 1.45; }
    .pred-short-tip {
      margin-top: 14px; padding: 12px 16px; background: #1a2332; border-radius: 10px;
      font-size: 0.85rem; color: #94a3b8; line-height: 1.5; border-left: 3px solid #f59e0b;
    }
    .pred-short-tip span { color: #fbbf24; font-weight: 600; margin-right: 8px; }

    /* Quick glance bar (legacy) */
    .glance-bar {
      display: flex; flex-wrap: wrap; gap: 12px 20px;
      background: linear-gradient(135deg, #1a2744, #1e293b);
      border: 1px solid #334155; border-radius: 14px;
      padding: 16px 20px; margin-bottom: 28px;
    }
    .gb-item { font-size: 0.85rem; color: #cbd5e1; line-height: 1.45; flex: 1; min-width: 140px; }
    .gb-item.gb-score { font-size: 1.8rem; font-weight: 800; color: #f1f5f9; flex: 0; min-width: auto; }
    .gb-item.gb-score span { font-size: 0.9rem; color: #64748b; font-weight: 500; }
    .gb-item.gb-dir { flex: 0; min-width: auto; align-self: center; font-weight: 600; }
    .gb-label { display: block; font-size: 0.65rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
    .gb-judge { flex: 1 1 100%; font-size: 0.8rem; color: #94a3b8; }

    /* Macro / judge sidebar */
    .macro-label { font-weight: 700; color: #93c5fd; font-size: 0.88rem; }
    .macro-desc { font-size: 0.72rem; color: #64748b; margin-top: 4px; line-height: 1.4; }
    .judge-text { font-size: 0.72rem; color: #94a3b8; line-height: 1.45; }
    .sim-row { display: flex; justify-content: space-between; font-size: 0.68rem; color: #94a3b8; padding: 4px 0; border-bottom: 1px solid #1e293b; }
    .sim-row span:first-child { color: #e2e8f0; }

    /* Main content */
    .article-main {
      flex: 1;
      min-width: 0;
    }
    .article-header {
      text-align: center;
      padding: 16px 0 32px;
      margin-bottom: 32px;
      border-bottom: 1px solid #1e293b;
    }
    .article-header h1 {
      font-size: 1.6rem;
      color: #f1f5f9;
      font-weight: 700;
    }
    .article-header .meta {
      margin-top: 8px;
      color: #64748b;
      font-size: 0.82rem;
    }

    #content { font-size: 1rem; color: #cbd5e1; }
    #content h2 {
      font-size: 1.15rem; color: #f1f5f9; margin: 32px 0 14px;
      padding: 10px 14px; background: #131c2e; border-radius: 10px;
      border-left: 3px solid #f59e0b; scroll-margin-top: 80px;
    }
    #content h2:first-child { margin-top: 0; }
    #content h3 { font-size: 1.1rem; color: #e2e8f0; margin: 22px 0 10px; }
    #content h4 { font-size: 1.05rem; color: #e2e8f0; margin: 18px 0 8px; }
    #content p { margin: 10px 0; }
    .equity-chart { margin: 20px 0; overflow-x: auto; }
    .equity-chart svg { display: block; max-width: 100%; height: auto; border-radius: 8px; }
    #content strong { color: #f1f5f9; font-weight: 600; }
    #content a { color: #60a5fa; text-decoration: none; border-bottom: 1px solid #60a5fa33; }
    #content a:hover { border-bottom-color: #60a5fa; }
    #content table {
      width: 100%; border-collapse: collapse; margin: 16px 0;
      background: #131c2e; border-radius: 10px; overflow: hidden; font-size: 0.9rem;
    }
    #content th {
      background: #1a2332; padding: 10px 14px; text-align: left;
      color: #94a3b8; font-weight: 600; font-size: 0.8rem;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    #content td { padding: 10px 14px; border-top: 1px solid #1e293b; }
    #content code {
      font-family: "JetBrains Mono", "Fira Code", monospace;
      font-size: 0.88em; background: #1a2332; padding: 2px 8px; border-radius: 4px; color: #e2e8f0;
    }
    #content pre {
      background: #0f172a; border: 1px solid #1e293b; border-radius: 10px;
      padding: 16px 20px; margin: 16px 0; overflow-x: auto;
    }
    #content pre code { background: transparent; padding: 0; font-size: 0.85rem; color: #e2e8f0; }
    #content blockquote {
      border-left: 3px solid #f59e0b; background: #131c2e;
      padding: 10px 18px; margin: 12px 0; border-radius: 0 8px 8px 0; color: #94a3b8;
    }
    #content ul, #content ol { margin: 6px 0; padding-left: 24px; }
    #content li { margin: 4px 0; }
    #content hr { border: none; height: 1px; background: #1e293b; margin: 28px 0; }

    .footer-meta {
      margin-top: 40px; padding-top: 20px; border-top: 1px solid #1e293b;
      text-align: center; color: #475569; font-size: 0.78rem;
    }

    @media (max-width: 860px) {
      .pred-hero { grid-template-columns: 1fr; }
      .pred-meta-col { flex-direction: row; flex-wrap: wrap; align-items: flex-start; }
      .sc-grid { grid-template-columns: 1fr; }
      .article-layout { flex-direction: column; padding: 24px 16px 60px; }
      .sidebar { position: static; width: 100%; display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
      .score-gauge { margin-bottom: 0; }
      .article-header h1 { font-size: 1.35rem; }
      #content { font-size: 0.95rem; }
      .topbar { padding: 0 16px; }
    }
  </style>
</head>
<body>
  <nav class="topbar">
    <div class="topbar-left">
      <a href="/"><span class="logo">🥇 GoldRush</span></a>
      <span class="sep">/</span>
      <span class="report-date">${esc(dateLabel)} 分析报告</span>
    </div>
    <a href="/">← 返回列表</a>
  </nav>

  <div class="article-layout">
    <aside class="sidebar">
      ${scoreHtml}
      ${macroHtml}
      ${dims.length ? `<div class="sidebar-block"><div class="sb-title">四维度</div>${dimRows}</div>` : ''}
      ${waterfallHtml}
      ${judgeHtml}
      ${similarHtml}
      ${tocHtml}
    </aside>
    <div class="article-main">
      ${dashboardHtml}
      <div class="article-header">
        <h1>详细分析</h1>
        <div class="meta">${esc(dateLabel)} · 以下内容为完整研报</div>
      </div>
      <div id="content"></div>
      <div class="footer-meta">
        报告由 GoldRush 自动生成 · 仅供研究参考，不构成投资建议
      </div>
    </div>
  </div>

  <script>
    const md = \`${esc(mdContent(displayMd))}\`;
    const tocIds = ${JSON.stringify(tocItems.map(t => t.id))};
    const tocTitles = ${JSON.stringify(tocItems.map(t => t.title))};

    let html = DOMPurify.sanitize(marked.parse(md), MARKDOWN_PURIFY_OPTS);
    // 为 h2 注入锚点 id，便于目录跳转
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const h2s = wrap.querySelectorAll('h2');
    h2s.forEach((h2, i) => {
      if (tocIds[i]) h2.id = tocIds[i];
    });
    document.getElementById('content').innerHTML = wrap.innerHTML;
  </script>
</body>
</html>`;
}

/** 将 Markdown 原始内容转为安全的 JS 模板字符串（嵌入到 `` 反引号模板中） */
function mdContent(raw) {
  return raw
    .replace(/\\/g, '\\\\')
    .replace(/\`/g, '\\`')
    .replace(/\$/g, '\\$');
}

// ===== HTTP 服务 =====

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const relPath = url.pathname === '/' ? '' : decodeURIComponent(url.pathname);
  const filePath = path.resolve(DOCS_DIR, relPath.replace(/^\//, ''));

  // 安全校验：禁止路径穿越
  if (filePath !== DOCS_DIR && !filePath.startsWith(DOCS_ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  // 目录请求 → 文件列表
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readdir(DOCS_DIR, (err, allFiles) => {
      if (err) {
        res.writeHead(500);
        return res.end('Server error');
      }
      const mdFiles = allFiles.filter(f => f.endsWith('.md')).sort().reverse();
      const fileInfos = getFileInfos(mdFiles);
      const html = renderIndex(fileInfos);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    return;
  }

  // .md 文件 → 渲染为文章页
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md') {
    fs.readFile(filePath, 'utf-8', (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not Found');
      }
      const filename = path.basename(filePath);
      const html = renderArticle(filename, data);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    return;
  }

  // 其他静态文件
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`🥇 GoldRush Docs Server running on http://${HOST}:${PORT}`);
});
