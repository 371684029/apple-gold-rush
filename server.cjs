#!/usr/bin/env node
// GoldRush Docs Server — 展示 docs/ 下的分析报告，带评分可视化、搜索过滤

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 80;
const DOCS_DIR = path.join(__dirname, 'docs');

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
    };
  });
}

// ===== 评分徽章 =====

function scoreBadge(score) {
  if (score == null) return '';
  let color, label;
  if (score >= 75) { color = '#22c55e'; label = '看多'; }
  else if (score >= 55) { color = '#f59e0b'; label = '中性'; }
  else { color = '#ef4444'; label = '看空'; }
  return `<span class="s-badge" style="background:${color}22;color:${color};border-color:${color}44">${score}<span class="s-label">${label}</span></span>`;
}

// ===== 文件列表页（含搜索过滤排序） =====

function renderIndex(fileInfos) {
  const rows = fileInfos.map(info => {
    const mtimeStr = info.mtime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return `<tr>
      <td class="file-score">${scoreBadge(info.score)}</td>
      <td class="file-name">
        <a href="/${info.filename}">${esc(info.filename)}</a>
        <span class="date-label">${info.dateLabel}</span>
      </td>
      <td class="file-dims">${info.dims.map(d => `<span class="dim-tag">${d.name.slice(0, 2)} ${d.score}</span>`).join('')}</td>
      <td class="file-size">${info.sizeKB} KB</td>
      <td class="file-time">${mtimeStr}</td>
    </tr>`;
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
    .container { max-width: 1100px; margin: 0 auto; padding: 40px 24px; }

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

    /* Score badge */
    .s-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      border-radius: 20px;
      font-weight: 700;
      font-size: 1rem;
      border: 1px solid;
      white-space: nowrap;
    }
    .s-badge .s-label {
      font-size: 0.65rem;
      font-weight: 500;
      opacity: 0.85;
    }

    /* Table */
    .table-wrap {
      background: #1e293b;
      border: 1px solid #2d3a4e;
      border-radius: 14px;
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; }
    th {
      background: #1a2332;
      text-align: left;
      padding: 12px 14px;
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #64748b;
      font-weight: 600;
    }
    td { padding: 12px 14px; border-top: 1px solid #2d3a4e; vertical-align: middle; }
    tr { transition: background 0.15s; }
    tr:hover td { background: #243045; }
    td.file-score { width: 80px; }
    td.file-name { min-width: 220px; }
    td.file-name a {
      color: #e2e8f0;
      font-weight: 500;
      text-decoration: none;
      display: block;
      line-height: 1.4;
    }
    td.file-name a:hover { color: #60a5fa; }
    .date-label {
      display: block;
      font-size: 0.72rem;
      color: #64748b;
      margin-top: 2px;
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
    td.file-dims { min-width: 160px; }
    td.file-size, td.file-time { color: #94a3b8; font-size: 0.82rem; white-space: nowrap; }

    /* Hidden rows */
    .hidden { display: none; }

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
      .container { padding: 24px 16px; }
      header h1 { font-size: 1.5rem; }
      .stats { gap: 8px; }
      .stat-card { padding: 12px 16px; min-width: 80px; }
      td.file-size, th:nth-child(4) { display: none; }
      td.file-time, th:nth-child(5) { display: none; }
      td.file-dims, th:nth-child(3) { display: none; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🥇 GoldRush</h1>
      <p class="subtitle">黄金投资研究 · 每日分析报告</p>
    </header>

    <div class="stats">
      <div class="stat-card"><div class="num gold">${total}</div><div class="label">报告总数</div></div>
      ${total > 0 ? `
      <div class="stat-card"><div class="num green">${bullish}</div><div class="label">看多</div></div>
      <div class="stat-card"><div class="num yellow">${neutral}</div><div class="label">中性</div></div>
      <div class="stat-card"><div class="num red">${bearish}</div><div class="label">看空</div></div>
      <div class="stat-card"><div class="num gold">${avgScore}</div><div class="label">均分</div></div>
      ` : ''}
    </div>

    ${total > 0 ? `
    <div class="toolbar">
      <input type="text" class="search-box" id="search" placeholder="🔍 搜索报告（文件名、日期、评分...）" oninput="filterTable()">
      <button class="sort-btn active" id="sort-date" onclick="setSort('date')">📅 日期</button>
      <button class="sort-btn" id="sort-score" onclick="setSort('score')">📊 评分</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th>评分</th><th>文件名</th><th>维度</th><th>大小</th><th>修改时间</th>
      </tr></thead>
      <tbody id="tbody">${rows}</tbody>
    </table></div>` : `<div class="empty">
      <div class="icon">📭</div>
      <p>暂无分析报告<br>运行 <code>node dist/index.js analysis --md</code> 生成第一份</p>
    </div>`}

    <footer>
      <p>报告由 <a href="/">GoldRush</a> 自动生成 · 仅供研究参考，不构成投资建议</p>
    </footer>
  </div>

  <script>
    // 搜索过滤
    function filterTable() {
      const q = document.getElementById('search').value.toLowerCase();
      const rows = document.querySelectorAll('#tbody tr');
      for (const row of rows) {
        const text = row.textContent.toLowerCase();
        row.classList.toggle('hidden', q && !text.includes(q));
      }
    }

    // 排序
    let sortMode = 'date';
    function setSort(mode) {
      sortMode = mode;
      document.getElementById('sort-date').classList.toggle('active', mode === 'date');
      document.getElementById('sort-score').classList.toggle('active', mode === 'score');
      doSort();
    }

    function doSort() {
      const tbody = document.getElementById('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      rows.sort((a, b) => {
        if (sortMode === 'date') {
          const da = a.querySelector('.date-label')?.textContent || '';
          const db = b.querySelector('.date-label')?.textContent || '';
          return db.localeCompare(da); // 倒序（最新在前）
        }
        // 评分排序
        const sa = parseInt(a.querySelector('.s-badge')?.textContent) || 0;
        const sb = parseInt(b.querySelector('.s-badge')?.textContent) || 0;
        return sb - sa; // 高分在前
      });
      for (const row of rows) tbody.appendChild(row);
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

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(dateLabel)} — GoldRush 分析报告</title>
  <script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
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
    #content h2 { font-size: 1.3rem; color: #f1f5f9; margin: 28px 0 12px; }
    #content h3 { font-size: 1.1rem; color: #e2e8f0; margin: 22px 0 10px; }
    #content h4 { font-size: 1.05rem; color: #e2e8f0; margin: 18px 0 8px; }
    #content p { margin: 10px 0; }
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
      ${dimRows ? `<div style="border-top:1px solid #1e293b;padding-top:16px">${dimRows}</div>` : ''}
    </aside>
    <div class="article-main">
      <div class="article-header">
        <h1>${esc(dateLabel)} 黄金投资研究</h1>
        <div class="meta">${esc(mdFilename)}</div>
      </div>
      <div id="content"></div>
      <div class="footer-meta">
        报告由 GoldRush 自动生成 · 仅供研究参考，不构成投资建议
      </div>
    </div>
  </div>

  <script>
    const md = \`${esc(mdContent(rawMarkdown))}\`;
    document.getElementById('content').innerHTML = marked.parse(md);
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
  let filePath = path.join(DOCS_DIR, url.pathname === '/' ? '' : url.pathname);

  // 安全校验
  if (!filePath.startsWith(DOCS_DIR)) {
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🥇 GoldRush Docs Server running on http://0.0.0.0:${PORT}`);
});
