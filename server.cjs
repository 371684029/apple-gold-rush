#!/usr/bin/env node
// GoldRush Docs Server — 展示 docs/ 下的分析报告，带评分可视化、搜索过滤

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { marked } = require('marked');
const { sanitizeMarkdownHtml } = require('./web/md-sanitize.cjs');
const { processArticleContent } = require('./web/article-collapse.cjs');

const PORT = parseInt(process.env.PORT || '80', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DOCS_DIR = path.resolve(__dirname, 'docs');
const DOCS_ROOT = DOCS_DIR + path.sep;
/** 校准样本少于此数时醒目提示「样本不足」 */
const CALIBRATION_SAMPLE_WARN = 5;

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

/** 提取量化评分对比行：🔢 量化评分: 63/100 | LLM: 67/100 | 偏差: +4 */
function extractQuantScore(md) {
  const m = md.match(/量化评分[：:]\s*(\d+)\/100\s*\|\s*LLM[：:]\s*(\d+)\/100\s*\|\s*偏差[：:]\s*([+-]?\d+)/);
  if (!m) {
    // fallback: match just the quant score alone
    const alt = md.match(/🔢\s*量化评分[：:]\s*(\d+)\/100/);
    if (!alt) return null;
    return { quantScore: parseInt(alt[1], 10), llmScore: null, diff: null };
  }
  return { quantScore: parseInt(m[1], 10), llmScore: parseInt(m[2], 10), diff: parseInt(m[3], 10) };
}

/** 提取四维度评分（仅匹配表格行，避免正文中误匹配） */
function extractDimensionScores(md) {
  const seen = new Set();
  const dims = [];
  // 仅匹配表格行：| 技术面 | 59/100 | ...
  const pattern = /^\| (技术面|基本面|情绪面|基金面) \| (\d+)\/100/mg;
  let m;
  while ((m = pattern.exec(md)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
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

/** 30秒快速阅读卡片 — 首屏决策三件套 */
function renderQuickRead(meta) {
  const { scoreInfo, advice, dims, calibration, quantInfo } = meta;
  if (!scoreInfo) return '';

  const dimLabels = dims && dims.length
    ? dims.map(d => {
        const label = d.score >= 60 ? '偏多' : d.score <= 40 ? '偏空' : '中性';
        return `${d.name}${label}`;
      }).join(' · ')
    : '';

  const warnText = (calibration?.sample != null && calibration.sample < 20)
    ? `⚠️ 校准样本仅${calibration.sample}次，仅供参考`
    : '';

  // 量化评分小标签
  const quantBadge = quantInfo?.quantScore != null
    ? `<span class="qr-quant">🔢 量化 ${quantInfo.quantScore}</span>`
    : '';

  return `<div class="quick-read-card" style="border-left-color:${advice.color}">
    <div class="qr-left">
      <div class="qr-score">${scoreInfo.score}<span class="qr-total">/100</span></div>
      ${quantBadge}
      <div class="qr-dir">${advice.emoji} ${advice.label}</div>
    </div>
    <div class="qr-body">
      <div class="qr-action">💡 ${esc(advice.action)}</div>
      ${dimLabels ? `<div class="qr-why">${esc(dimLabels)}</div>` : ''}
      ${warnText ? `<div class="qr-warn">${esc(warnText)}</div>` : ''}
    </div>
  </div>`;
}

/** 主力流向专用仪表盘 */
function renderFlowDashboard(rawMarkdown) {
  // Extract scores from flow markdown structure
  const scoreMatch = rawMarkdown.match(/综合评分[：:]\s*\*{0,2}(\d+)\/100\*{0,2}/);
  const score = scoreMatch ? parseInt(scoreMatch[1], 10) : null;

  // Extract section scores: CFTC, ETF, 央行, GLD
  const sections = [];
  const sectionNames = [
    { key: 'CFTC', label: 'CFTC' },
    { key: 'GLD', label: '黄金ETF' },
    { key: '央行', label: '央行' },
    { key: '背离', label: '背离信号' },
  ];

  for (const { key, label } of sectionNames) {
    const pattern = new RegExp(`## .*${key}[\\s\\S]*?(\\d+)/100`);
    const m = rawMarkdown.match(pattern);
    if (m) {
      const val = parseInt(m[1], 10);
      let cls = 'neutral';
      if (val >= 60) cls = 'bullish';
      else if (val <= 40) cls = 'bearish';
      sections.push({ label, score: val, cls });
    }
  }

  if (!score) return '';

  const scoreColor = score >= 75 ? '#22c55e' : score >= 55 ? '#f59e0b' : '#ef4444';

  const gaugeHtml = sections.length
    ? sections.map(s => `
      <div class="flow-gauge ${s.cls}">
        <div class="fg-label">${esc(s.label)}</div>
        <div class="fg-score">${s.score}</div>
        <div class="fg-bar"><div class="fg-fill" style="width:${s.score}%"></div></div>
      </div>`).join('')
    : '';

  // Check for divergence warnings
  const divergenceMatch = rawMarkdown.match(/背离[^\n]*?(\d+)[^\n]*?(\d+)/);
  const hasDivergence = divergenceMatch && Math.abs(parseInt(divergenceMatch[1], 10) - parseInt(divergenceMatch[2], 10)) > 15;

  return `<div class="flow-dashboard">
    <div class="flow-hero">
      <div class="flow-main-score">
        <div class="flow-big-num" style="color:${scoreColor}">${score}</div>
        <div class="flow-big-label">主力综合评分</div>
      </div>
      <div class="flow-gauges">${gaugeHtml}</div>
    </div>
    ${hasDivergence ? '<div class="flow-warning">⚠️ 检测到背离信号，请结合多维度综合判断</div>' : ''}
  </div>`;
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

/** 渲染 Markdown 前去掉已在仪表盘/侧栏展示的冗余块 */
function stripDashboardDuplicates(md) {
  // Helper: strip a Markdown section by its h2 title
  const stripSection = (title) => {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return md.replace(new RegExp(`## ${escaped}[\\s\\S]*?(?=\\n## |\\n---|\\s*$)`, ''), '');
  };
  md = stripSection('📊 评分构成');
  md = stripSection('综合研判');
  md = stripSection('📈 四维度摘要');
  return md;
}

/** 校准样本不足横幅 */
function renderSampleWarn(calibration) {
  const sample = calibration?.sample;
  if (sample == null) {
    return `<div class="sample-warn" role="status">⚠️ 校准样本积累中，历史命中率仅供参考，请以定投纪律为主</div>`;
  }
  if (sample < CALIBRATION_SAMPLE_WARN) {
    return `<div class="sample-warn" role="status">⚠️ 同分段样本仅 <strong>${sample}</strong> 次（&lt;${CALIBRATION_SAMPLE_WARN}），准确率波动大，勿过度解读</div>`;
  }
  return '';
}

/** 预测仪表盘（文章页顶部）— 首屏只留决策三件套，信任条/短期 tip 可折叠 */
function renderPredictionDashboard(meta) {
  const { scoreInfo, advice, confidence, calibration, scenarios, strategies, similarSummary, macro, quantInfo } = meta;
  if (!scoreInfo) return '';

  const score = scoreInfo.score;
  const confPct = confidence != null ? confidence : '—';
  const confClass = confidence >= 70 ? 'good' : confidence >= 50 ? 'mid' : 'low';

  // Calibration badge: show stats directly
  const calibParts = [];
  if (calibration?.sample != null) calibParts.push(`同分段 ${calibration.sample} 次`);
  if (calibration?.accuracy != null) calibParts.push(`5日涨 ${calibration.accuracy}%`);
  if (calibration?.bias) calibParts.push(`${calibration.bias}`);
  const calibBadge = calibParts.length
    ? `<div class="pred-calib-badge">${calibParts.join(' · ')}</div>`
    : '';
  // Macro inside calibration area if present
  const macroLine = macro ? `<div class="pred-macro-inline">🌐 ${esc(macro.label)}</div>` : '';

  // Action box — most prominent after score
  const actionBoxHtml = `
    <div class="pred-action-box" style="background:${advice.bg};border-color:${advice.color}">
      <div class="pred-action-label">💡 定投建议</div>
      <div class="pred-action-text">${esc(advice.action)}</div>
    </div>`;

  const scenarioHtml = scenarios ? scenarios.map(s => `
    <div class="sc-card sc-${s.cls}">
      <div class="sc-head"><span>${s.icon} ${esc(s.name)}</span><span class="sc-pct">${s.probability}%</span></div>
      <div class="sc-bar"><div class="sc-fill" style="width:${s.probability}%"></div></div>
      <div class="sc-action">${esc(s.action || '')}</div>
    </div>`).join('') : '';

  const trustParts = [];
  if (calibration?.accuracy != null) {
    trustParts.push(`同分段历史 5 日上涨概率 <strong>${calibration.accuracy}%</strong>（${esc(calibration.range)}，样本 ${calibration.sample ?? '—'}）`);
  }
  if (similarSummary) {
    trustParts.push(`历史相似日 ${similarSummary.total} 次中 ${similarSummary.upRate}% 上涨，平均 ${similarSummary.avgReturn >= 0 ? '+' : ''}${similarSummary.avgReturn}%`);
  }
  const trustInner = trustParts.length
    ? trustParts.join('<br>')
    : '样本积累中，结论供参考，请结合定投纪律';

  // 量化评分参考线
  const quantLine = quantInfo?.quantScore != null ? (() => {
    const q = quantInfo.quantScore;
    const d = quantInfo.diff ?? (score - q);
    const absD = Math.abs(d);
    let label, color;
    if (d > 5) { label = `LLM 偏高 +${absD}`; color = '#ef4444'; }
    else if (d < -5) { label = `LLM 偏低 -${absD}`; color = '#22c55e'; }
    else if (d > 0) { label = `LLM 偏高 +${absD}`; color = '#f59e0b'; }
    else if (d < 0) { label = `LLM 偏低 -${absD}`; color = '#f59e0b'; }
    else { label = '一致'; color = '#94a3b8'; }
    return `<div class="pred-quant-bar">
      <span class="pred-quant-label">🔢 量化</span>
      <span class="pred-quant-value">${q}</span>
      <span class="pred-quant-diff" style="color:${color}">${label}</span>
    </div>`;
  })() : '';

  return `<section class="pred-dashboard" aria-label="预测结论">
    ${renderSampleWarn(calibration)}
    <div class="pred-hero" style="--pred-color:${advice.color}">
      <div class="pred-score-col">
        <div class="pred-score-num">${score}</div>
        <div class="pred-score-sub">综合分 / 100</div>
        <div class="pred-score-meter"><div class="pred-score-fill" style="width:${score}%;background:${advice.color}"></div></div>
        ${quantLine}
        ${calibBadge}
        ${macroLine}
      </div>
      <div class="pred-verdict-col">
        <div class="pred-dir-tag">${advice.emoji} ${advice.label}</div>
        ${actionBoxHtml}
        <div class="pred-pills">
          <div class="pred-pill conf-${confClass}">数据置信 ${confPct}%</div>
          ${strategies.dca ? `<div class="pred-pill">${esc(strategies.dca)}</div>` : ''}
          ${strategies.position ? `<div class="pred-pill">${esc(strategies.position)}</div>` : ''}
        </div>
      </div>
    </div>
    ${scenarioHtml ? `<div class="pred-scenarios"><div class="pred-section-title">三情景概率</div><div class="sc-grid">${scenarioHtml}</div></div>` : ''}
    <details class="pred-secondary">
      <summary>历史佐证与短期提示</summary>
      <div class="pred-trust"><span class="pred-trust-icon">🎯</span><div class="pred-trust-body">${trustInner}</div></div>
      ${strategies.short ? `<div class="pred-short-tip"><span>⏱️ 短期</span>${esc(strategies.short)}</div>` : ''}
    </details>
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

/** 报告类型：analysis / digest / other */
function classifyDoc(filename) {
  if (filename.includes('flow')) return 'flow';
  if (filename.includes('digest')) return 'digest';
  if (filename.includes('analysis')) return 'analysis';
  if (filename.includes('calibration')) return 'calibration';
  return 'other';
}

function getFileInfos(files) {
  return files.map(f => {
    const fp = path.join(DOCS_DIR, f);
    const stats = fs.statSync(fp);
    const md = fs.readFileSync(fp, 'utf-8');
    const scoreInfo = extractScore(md);
    const quantInfo = extractQuantScore(md);
    const dims = extractDimensionScores(md);
    const kind = classifyDoc(f);
    let dateLabel = f.replace(/\.md$/, '');
    if (kind === 'analysis') dateLabel = f.replace('goldrush-analysis-', '').replace('.md', '');
    else if (kind === 'digest') {
      dateLabel = f.includes('latest')
        ? '周期摘要 · 最新'
        : f.replace('goldrush-digest-', '').replace('.md', '');
    }
    return {
      filename: f,
      kind,
      dateLabel,
      mtime: stats.mtime,
      sizeKB: (stats.size / 1024).toFixed(1),
      score: scoreInfo?.score ?? null,
      direction: scoreInfo?.direction ?? null,
      dims,
      quantInfo,
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

/** 从文件名提取日期字符串（YYYY-MM-DD），无法提取则返回空串（排在末尾） */
function extractFileDate(filename) {
  const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

// ===== 文件列表页（含搜索过滤排序） =====

function renderIndex(fileInfos) {
  const analyses = fileInfos.filter(i => i.kind === 'analysis');
  const digests = fileInfos.filter(i => i.kind === 'digest');
  const others = fileInfos.filter(i => i.kind !== 'analysis' && i.kind !== 'digest');

  const latest = analyses[0] ?? null;
  const rest = analyses.slice(1);

  const heroHtml = latest ? `<a href="/${latest.filename}" class="hero-card dir-${latest.direction || 'neutral'}">
    <div class="hero-badge">最新研判</div>
    <div class="hero-left">${scoreBadge(latest.score)}</div>
    <div class="hero-body">
      <div class="hero-date">${esc(latest.dateLabel)}</div>
      ${latest.advice ? `<div class="hero-verdict">${latest.advice.emoji} ${esc(latest.advice.headline)}</div>` : '<div class="hero-title">黄金投资日报</div>'}
      ${latest.advice ? `<div class="hero-action">💡 ${esc(latest.advice.action)}</div>` : ''}
      ${latest.scenarios ? `<div class="hero-scenarios">${latest.scenarios.map(s => `<span class="sc-mini sc-${s.cls}">${s.icon}${s.probability}%</span>`).join('')}</div>` : ''}
      ${latest.calibration && (latest.calibration.sample == null || latest.calibration.sample < CALIBRATION_SAMPLE_WARN)
        ? `<div class="hero-sample-warn">⚠️ 校准样本不足${latest.calibration.sample != null ? `（${latest.calibration.sample}）` : ''}</div>` : ''}
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
        <div class="rc-meta">${mtimeStr}</div>
      </div>
    </a>`;
  }).join('\n');

  const digestRows = digests.map(info => {
    const mtimeStr = info.mtime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<a href="/${info.filename}" class="report-card kind-digest" data-search="${esc(info.filename + ' ' + info.dateLabel + ' digest 摘要')}">
      <div class="rc-kind">摘要</div>
      <div class="rc-body">
        <div class="rc-date">${esc(info.dateLabel)}</div>
        <div class="rc-snippet">周期摘要 · 均分与跳变一览</div>
        <div class="rc-meta">${mtimeStr}</div>
      </div>
    </a>`;
  }).join('\n');

  const otherRows = others.map(info => {
    return `<a href="/${info.filename}" class="report-card kind-other" data-search="${esc(info.filename)}">
      <div class="rc-kind">其它</div>
      <div class="rc-body">
        <div class="rc-date">${esc(info.dateLabel)}</div>
        <div class="rc-snippet muted">${esc(info.filename)}</div>
      </div>
    </a>`;
  }).join('\n');

  // 统计（仅日度分析）
  const total = analyses.length;
  const bullish = analyses.filter(i => i.direction === 'bullish').length;
  const bearish = analyses.filter(i => i.direction === 'bearish').length;
  const neutral = analyses.filter(i => i.direction === 'neutral' || (i.direction === null && i.score != null)).length;
  const avgScore = total > 0 ? Math.round(analyses.reduce((s, i) => s + (i.score ?? 50), 0) / total) : '—';

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
    .hero-sample-warn { font-size: 0.75rem; color: #fcd34d; margin: 6px 0; }
    .sc-mini {
      font-size: 0.72rem; font-weight: 700; padding: 3px 8px; border-radius: 6px;
      background: #1a2332; border: 1px solid #334155;
    }
    .sc-mini.sc-base { color: #94a3b8; }
    .sc-mini.sc-up { color: #22c55e; border-color: #22c55e33; }
    .sc-mini.sc-down { color: #ef4444; border-color: #ef444433; }
    .rc-verdict { margin: 6px 0; }
    .rc-kind {
      flex-shrink: 0; align-self: center;
      font-size: 0.68rem; font-weight: 700; letter-spacing: 1px;
      color: #93c5fd; background: #1e3a5f; border: 1px solid #334155;
      padding: 6px 10px; border-radius: 8px;
    }
    .report-card.kind-digest { border-left-color: #60a5fa; }
    .report-card.kind-other { border-left-color: #64748b; }
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
    ${rest.length ? `<div class="section-label">历史日报</div><div class="card-grid" id="card-grid">${cardRows}</div>` : ''}
    ${digests.length ? `<div class="section-label" style="margin-top:28px">周期摘要</div><div class="card-grid" id="digest-grid">${digestRows}</div>` : ''}
    ${others.length ? `<div class="section-label" style="margin-top:28px">其它文档</div><div class="card-grid">${otherRows}</div>` : ''}
    ` : `<div class="empty">
      <div class="icon">📭</div>
      <p>暂无分析报告<br>运行 <code>node dist/index.js analysis --md</code> 生成第一份</p>
    </div>`}

    <footer>
      <p>报告由 <a href="/">GoldRush</a> 自动生成 · 仅供研究参考，不构成投资建议</p>
      <p style="margin-top:8px"><a href="/#digest-grid">📰 周期摘要</a>${digests[0] ? ` · <a href="/${digests[0].filename}">打开最新摘要</a>` : ''}</p>
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
  const kind = classifyDoc(mdFilename);
  const dateLabel = kind === 'analysis'
    ? mdFilename.replace('goldrush-analysis-', '').replace('.md', '')
    : mdFilename.replace(/\.md$/, '');
  const scoreInfo = extractScore(rawMarkdown);
  const dims = extractDimensionScores(rawMarkdown);
  const breakdown = extractScoreBreakdown(rawMarkdown);
  const macro = extractMacroRegime(rawMarkdown);
  const judge = extractJudgeVerdict(rawMarkdown);
  const similar = extractSimilarDays(rawMarkdown);
  const similarSummary = summarizeSimilarDays(similar);
  const calibration = extractCalibration(rawMarkdown);
  const confidence = extractDataConfidence(rawMarkdown);
  const scenarios = extractScenarios(rawMarkdown);
  const strategies = extractStrategies(rawMarkdown);
  const quantInfo = extractQuantScore(rawMarkdown);
  const advice = scoreInfo ? plainAdvice(scoreInfo.score, scoreInfo.direction) : null;

  // Quick-read card only for analysis
  const quickReadHtml = kind === 'analysis' ? renderQuickRead({
    scoreInfo, advice, dims, calibration, quantInfo,
  }) : '';

  // Flow reports get specialized dashboard
  const flowDashboardHtml = kind === 'flow' ? renderFlowDashboard(rawMarkdown) : '';

  const dashboardHtml = kind === 'analysis' ? renderPredictionDashboard({
    scoreInfo, advice, confidence, calibration, scenarios, strategies, similarSummary, macro, quantInfo,
  }) : '';

  const displayMd = kind === 'analysis' ? stripDashboardDuplicates(rawMarkdown) : rawMarkdown;

  const dimRows = dims.map(d => {
    const pct = d.score;
    let c = '#22c55e';
    if (pct < 55) c = '#ef4444';
    else if (pct < 75) c = '#f59e0b';
    return `<div class="dim-bar-row"><span class="dim-name">${d.name}</span><div class="dim-bar-bg"><div class="dim-bar-fill" style="width:${pct}%;background:${c}"></div></div><span class="dim-val">${d.score}</span></div>`;
  }).join('');

  const tocItems = [];
  for (const m of displayMd.matchAll(/^## (.+)$/gm)) {
    const title = m[1].trim();
    if (title.startsWith('📊 评分构成') || title === '综合研判') continue;
    const id = 'sec-' + tocItems.length;
    tocItems.push({ title, id });
  }
  const tocHtml = tocItems.length > 1 ? `<nav class="sidebar-block toc">
    <div class="sb-title">目录</div>
    ${tocItems.map(t => `<a href="#${t.id}" class="toc-link" data-sec="${t.id}">${esc(t.title)}</a>`).join('')}
  </nav>` : '';

  // 侧栏：默认只留目录 + 四维条；其余全部折叠
  const sidebarScoreMeter = scoreInfo ? `
    <div class="sidebar-score-meter">
      <div class="ssm-label">综合 ${scoreInfo.score}</div>
      <div class="ssm-bar"><div class="ssm-fill" style="width:${scoreInfo.score}%;background:${scoreInfo.score >= 75 ? '#22c55e' : scoreInfo.score >= 55 ? '#f59e0b' : '#ef4444'}"></div></div>
      <div class="ssm-dir">${scoreInfo.direction === 'bullish' ? '📈 偏多' : scoreInfo.direction === 'bearish' ? '📉 偏空' : '➡️ 中性'}</div>
    </div>` : '';

  const sidebarExtras = [];
  if (macro) {
    sidebarExtras.push(`<div class="sidebar-block macro-chip"><div class="sb-title">宏观阶段</div><div class="macro-label">${esc(macro.label)}</div><div class="macro-desc">${esc(macro.description)}</div></div>`);
  }
  if (breakdown) {
    sidebarExtras.push(`<div class="sidebar-block"><div class="sb-title">评分构成</div><div class="waterfall">${renderScoreWaterfall(breakdown)}</div></div>`);
  }
  if (judge) {
    sidebarExtras.push(`<div class="sidebar-block judge-box"><div class="sb-title">裁决摘要</div><p class="judge-text">${esc(judge.slice(0, 200))}${judge.length > 200 ? '…' : ''}</p></div>`);
  }
  if (similar && similar.length) {
    sidebarExtras.push(`<div class="sidebar-block"><div class="sb-title">历史佐证</div><div class="sim-summary">${similarSummary ? `相似日 ${similarSummary.upRate}% 上涨 · 均 ${similarSummary.avgReturn >= 0 ? '+' : ''}${similarSummary.avgReturn}%` : ''}</div>${similar.map(s => `<div class="sim-row"><span>${esc(s.date)}</span><span>${esc(s.similarity)}</span><span class="${parseFloat(s.ret) >= 0 ? 'up' : 'down'}">${esc(s.ret)}</span></div>`).join('')}</div>`);
  }

  const sidebarHtml = `
      ${sidebarScoreMeter}
      ${dims.length ? `<div class="sidebar-block"><div class="sb-title">四维度</div>${dimRows}</div>` : ''}
      ${tocHtml}
      ${sidebarExtras.length ? `<details class="sidebar-more"><summary>更多侧栏</summary>${sidebarExtras.join('')}</details>` : ''}
  `;

  // 服务端渲染 Markdown → 折叠分节 → 净化
  let contentHtml = marked.parse(displayMd, { breaks: true, gfm: true });
  if (kind === 'analysis' && tocItems.length) {
    contentHtml = processArticleContent(contentHtml, tocItems);
  }
  contentHtml = sanitizeMarkdownHtml(contentHtml);

  const pageTitle = kind === 'flow' ? `${esc(dateLabel)} — 主力流向` : kind === 'digest' ? `${esc(dateLabel)} — 周期摘要` : `${esc(dateLabel)} — GoldRush 分析报告`;
  const headerTitle = kind === 'flow' ? '主力流向' : kind === 'digest' ? '周期摘要' : '详细分析';
  const headerMeta = kind === 'flow'
    ? `${esc(dateLabel)} · CFTC · ETF · 央行`
    : kind === 'digest'
    ? `${esc(dateLabel)} · 均分与跳变一览`
    : `${esc(dateLabel)} · 策略默认展开，长文可折叠`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle}</title>
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
    .sidebar-more {
      margin-top: 16px; width: 100%;
      background: #131c2e; border: 1px solid #1e293b; border-radius: 10px; padding: 8px 10px;
    }
    .sidebar-more > summary {
      cursor: pointer; font-size: 0.72rem; color: #94a3b8; list-style: none;
      padding: 4px 2px; user-select: none;
    }
    .sidebar-more > summary::-webkit-details-marker { display: none; }
    .sidebar-more[open] > summary { color: #fbbf24; margin-bottom: 8px; }
    .score-gauge.compact .sg-circle { width: 96px; height: 96px; }
    .score-gauge.compact .sg-inner { width: 70px; height: 70px; }
    .score-gauge.compact .sg-score { font-size: 1.4rem; }

    /* 样本不足 / 次级折叠 */
    .sample-warn {
      margin-bottom: 12px; padding: 10px 14px;
      background: #422006; border: 1px solid #f59e0b55; border-radius: 10px;
      color: #fcd34d; font-size: 0.82rem; line-height: 1.45;
    }
    .sample-warn strong { color: #fbbf24; }
    .pred-secondary {
      margin-top: 14px; background: #131c2e; border: 1px solid #1e293b;
      border-radius: 12px; padding: 10px 14px;
    }
    .pred-secondary > summary {
      cursor: pointer; color: #94a3b8; font-size: 0.82rem; list-style: none; user-select: none;
    }
    .pred-secondary > summary::-webkit-details-marker { display: none; }
    .pred-secondary[open] > summary { color: #fbbf24; margin-bottom: 8px; }
    .sc-desc { margin-top: 8px; font-size: 0.72rem; color: #64748b; }
    .sc-desc > summary { cursor: pointer; color: #94a3b8; }
    .sc-desc p { margin-top: 6px; line-height: 1.45; color: #94a3b8; }

    /* 正文分节折叠 */
    .collapse-toolbar {
      display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; justify-content: center;
    }
    .collapse-btn {
      background: #1e293b; border: 1px solid #334155; color: #94a3b8;
      border-radius: 8px; padding: 6px 12px; font-size: 0.78rem; cursor: pointer;
    }
    .collapse-btn:hover { border-color: #f59e0b55; color: #e2e8f0; }
    .md-section {
      margin: 12px 0 16px; background: #0f172a; border: 1px solid #1e293b;
      border-radius: 12px; overflow: hidden; scroll-margin-top: 80px;
    }
    .md-section-summary {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      cursor: pointer; list-style: none; user-select: none;
      padding: 12px 14px; background: #131c2e; border-left: 3px solid #f59e0b;
      color: #f1f5f9; font-weight: 600; font-size: 0.98rem;
    }
    .md-section-summary::-webkit-details-marker { display: none; }
    .md-section[data-sec-kind="short-strategy"] .md-section-summary,
    .md-section[data-sec-kind="mid-strategy"] .md-section-summary,
    .md-section[data-sec-kind="scenarios"] .md-section-summary {
      border-left-color: #22c55e;
    }
    .md-section[data-sec-kind="rebuttal"] .md-section-summary,
    .md-section[data-sec-kind="tail-risk"] .md-section-summary {
      border-left-color: #ef4444;
    }
    .md-sec-hint::after { content: '展开'; color: #64748b; font-size: 0.72rem; font-weight: 500; }
    .md-section[open] > .md-section-summary .md-sec-hint::after { content: '收起'; color: #fbbf24; }
    .md-section-body { padding: 4px 16px 16px; }
    .md-more-list, .md-cell-more {
      margin: 8px 0; padding: 8px 10px; background: #131c2e; border-radius: 8px; border: 1px solid #1e293b;
    }
    .md-more-list > summary, .md-cell-more > summary {
      cursor: pointer; color: #94a3b8; font-size: 0.8rem; list-style: none;
    }
    .md-more-list > summary::-webkit-details-marker,
    .md-cell-more > summary::-webkit-details-marker { display: none; }
    .md-cell-full { margin-top: 8px; color: #cbd5e1; font-size: 0.85rem; line-height: 1.5; }
    .toc-link.active { background: #1e293b; color: #f59e0b; }

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
    .pred-score-num { font-size: 4.5rem; font-weight: 800; color: #f8fafc; line-height: 1; }
    .pred-score-sub { font-size: 0.72rem; color: #64748b; margin-top: 4px; }
    .pred-score-meter { height: 6px; background: #0f172a; border-radius: 3px; margin-top: 10px; overflow: hidden; }
    .pred-score-fill { height: 100%; border-radius: 3px; transition: width 0.6s; }
    /* 量化评分对比行 */
    .pred-quant-bar {
      display: flex; align-items: center; gap: 8px;
      margin-top: 10px; padding: 6px 10px;
      background: #131c2e; border-radius: 8px; border: 1px solid #1e293b;
    }
    .pred-quant-label { font-size: 0.7rem; color: #64748b; }
    .pred-quant-value { font-size: 1rem; font-weight: 700; color: #94a3b8; }
    .pred-quant-diff { font-size: 0.72rem; font-weight: 600; }
    /* 快速阅读卡量化标签 */
    .qr-quant {
      display: block; text-align: center;
      font-size: 0.65rem; color: #64748b;
      padding: 2px 0;
    }
    .pred-emoji { font-size: 1.5rem; margin-bottom: 4px; }
    .pred-headline { font-size: 1.35rem; color: #f1f5f9; font-weight: 700; margin-bottom: 6px; line-height: 1.35; }
    .pred-tag { font-size: 0.82rem; color: var(--pred-color); font-weight: 600; margin-bottom: 12px; }
    .pred-action-box {
      background: linear-gradient(135deg, #1a2744, #1e293b);
      border: 2px solid var(--pred-color);
      border-radius: 12px; padding: 16px 18px;
    }
    .pred-action-label { font-size: 0.65rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
    .pred-action-text { font-size: 1.1rem; color: #f1f5f9; margin-top: 4px; font-weight: 600; line-height: 1.5; }
    .pred-macro { font-size: 0.78rem; color: #93c5fd; margin-top: 10px; }
    .pred-macro-inline { font-size: 0.72rem; color: #93c5fd; margin-top: 6px; }
    .pred-dir-tag { font-size: 1.1rem; font-weight: 700; color: var(--pred-color); margin-bottom: 10px; }
    .pred-pills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .pred-calib-badge {
      margin-top: 10px; padding: 6px 10px;
      background: #131c2e; border: 1px solid #334155; border-radius: 8px;
      font-size: 0.7rem; color: #94a3b8; line-height: 1.4;
    }
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

    /* ===== Quick Read Card ===== */
    .quick-read-card {
      display: flex; gap: 24px; max-width: 720px; margin: 0 auto 20px;
      background: linear-gradient(135deg, #1a2744, #1e293b);
      border: 1px solid #334155; border-radius: 14px;
      padding: 20px 24px; border-left-width: 4px;
    }
    .qr-left { flex-shrink: 0; text-align: center; }
    .qr-score { font-size: 3rem; font-weight: 800; color: #f1f5f9; line-height: 1; }
    .qr-score .qr-total { font-size: 1.2rem; color: #64748b; font-weight: 500; }
    .qr-dir { font-size: 0.9rem; font-weight: 600; margin-top: 6px; }
    .qr-body { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 6px; }
    .qr-action { font-size: 1.1rem; color: #f1f5f9; font-weight: 600; line-height: 1.4; }
    .qr-why { font-size: 0.8rem; color: #94a3b8; }
    .qr-warn { font-size: 0.75rem; color: #fcd34d; }

    /* ===== Sidebar Score Meter ===== */
    .sidebar-score-meter { margin-bottom: 16px; }
    .ssm-label { font-size: 0.75rem; color: #64748b; margin-bottom: 4px; }
    .ssm-bar { height: 8px; background: #1e293b; border-radius: 4px; overflow: hidden; margin-bottom: 4px; }
    .ssm-fill { height: 100%; border-radius: 4px; transition: width 0.5s; }
    .ssm-dir { font-size: 0.82rem; color: #94a3b8; }

    /* ===== Flow Dashboard ===== */
    .flow-dashboard { margin-bottom: 32px; }
    .flow-hero {
      display: flex; gap: 32px; align-items: center;
      background: linear-gradient(135deg, #1a2744, #1e293b);
      border: 1px solid #334155; border-radius: 16px; padding: 28px 32px;
    }
    .flow-main-score { text-align: center; flex-shrink: 0; }
    .flow-big-num { font-size: 4.5rem; font-weight: 800; line-height: 1; }
    .flow-big-label { font-size: 0.8rem; color: #64748b; margin-top: 6px; text-transform: uppercase; letter-spacing: 1px; }
    .flow-gauges { flex: 1; display: flex; flex-direction: column; gap: 12px; }
    .flow-gauge { display: flex; align-items: center; gap: 12px; }
    .fg-label { width: 48px; font-size: 0.78rem; color: #94a3b8; flex-shrink: 0; }
    .fg-score { width: 32px; font-size: 0.9rem; font-weight: 700; color: #f1f5f9; text-align: right; flex-shrink: 0; }
    .fg-bar { flex: 1; height: 6px; background: #0f172a; border-radius: 3px; overflow: hidden; }
    .fg-fill { height: 100%; border-radius: 3px; background: #f59e0b; }
    .flow-gauge.bullish .fg-fill { background: #22c55e; }
    .flow-gauge.bearish .fg-fill { background: #ef4444; }
    .flow-gauge.neutral .fg-fill { background: #f59e0b; }
    .flow-warning {
      margin-top: 12px; padding: 10px 16px;
      background: #422006; border: 1px solid #f59e0b55; border-radius: 10px;
      color: #fcd34d; font-size: 0.82rem;
    }
  </style>
</head>
<body>
  <nav class="topbar">
    <div class="topbar-left">
      <a href="/"><span class="logo">🥇 GoldRush</span></a>
      <span class="sep">/</span>
      <span class="report-date">${esc(dateLabel)}${kind === 'flow' ? ' 主力流向' : kind === 'digest' ? ' 周期摘要' : ' 分析报告'}</span>
    </div>
    <a href="/">← 返回列表</a>
  </nav>

  <div class="article-layout">
    <aside class="sidebar">
      ${sidebarHtml}
    </aside>
    <div class="article-main">
      ${flowDashboardHtml}
      ${quickReadHtml}
      ${dashboardHtml}
      <div class="article-header">
        <h1>${headerTitle}</h1>
        <div class="meta">${headerMeta}</div>
      </div>
      ${kind === 'analysis' && tocItems.length ? `<div class="collapse-toolbar">
        <button type="button" class="collapse-btn" id="btn-expand-all">全部展开</button>
        <button type="button" class="collapse-btn" id="btn-collapse-all">全部收起</button>
        <button type="button" class="collapse-btn" id="btn-reset-collapse">恢复默认</button>
      </div>` : ''}
      <div id="content">${contentHtml}</div>
      <div class="footer-meta">
        报告由 GoldRush 自动生成 · 仅供研究参考，不构成投资建议
      </div>
    </div>
  </div>

  <script>
    (function () {
      const KEY = 'goldrush-collapse-pref';
      const sections = () => Array.from(document.querySelectorAll('#content details.md-section'));

      function setAll(open) {
        for (const d of sections()) d.open = open;
        try { localStorage.setItem(KEY, open ? 'all-open' : 'all-closed'); } catch (_) {}
      }

      function resetDefault() {
        for (const d of sections()) {
          const kind = d.getAttribute('data-sec-kind') || '';
          d.open = ['short-strategy', 'mid-strategy', 'scenarios'].includes(kind);
        }
        try { localStorage.removeItem(KEY); } catch (_) {}
      }

      function applyPref() {
        let pref = null;
        try { pref = localStorage.getItem(KEY); } catch (_) {}
        if (pref === 'all-open') setAll(true);
        else if (pref === 'all-closed') setAll(false);
      }

      document.getElementById('btn-expand-all')?.addEventListener('click', () => setAll(true));
      document.getElementById('btn-collapse-all')?.addEventListener('click', () => setAll(false));
      document.getElementById('btn-reset-collapse')?.addEventListener('click', resetDefault);

      // TOC：打开对应章节并滚动
      document.querySelectorAll('.toc-link').forEach(a => {
        a.addEventListener('click', (e) => {
          const id = a.getAttribute('data-sec') || (a.getAttribute('href') || '').slice(1);
          const el = id ? document.getElementById(id) : null;
          if (!el) return;
          e.preventDefault();
          if (el.tagName === 'DETAILS') el.open = true;
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          document.querySelectorAll('.toc-link').forEach(x => x.classList.remove('active'));
          a.classList.add('active');
          history.replaceState(null, '', '#' + id);
        });
      });

      // 深链进入时展开目标节
      if (location.hash) {
        const el = document.getElementById(location.hash.slice(1));
        if (el && el.tagName === 'DETAILS') el.open = true;
      }

      applyPref();
    })();
  </script>
</body>
</html>`;
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
      const mdFiles = allFiles
        .filter(f => f.endsWith('.md'))
        .sort((a, b) => {
          const da = extractFileDate(a);
          const db = extractFileDate(b);
          // 最新在前，无日期的排最后
          if (da && !db) return -1;
          if (!da && db) return 1;
          if (da && db && da !== db) return db.localeCompare(da);
          return b.localeCompare(a);
        });
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
