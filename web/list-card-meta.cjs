/**
 * 首页历史日报列表：双打分条 + 较上日差分（含旧报告相邻推算）
 * 纯函数，供 server.cjs 与单测共用。
 */

'use strict';

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function fmtSigned(n, digits = 0) {
  if (n == null || !Number.isFinite(n)) return null;
  const v = digits > 0 ? Number(n.toFixed(digits)) : Math.round(n);
  if (v > 0) return `+${v}`;
  if (v === 0) return '±0';
  return String(v);
}

/**
 * 从单日 fileInfo 取出列表用双分数
 */
function listDualScores(info) {
  if (!info) return null;
  const llm = numOrNull(info.dualScore?.llm) ?? numOrNull(info.score);
  const quant = numOrNull(info.dualScore?.quant)
    ?? numOrNull(info.quantInfo?.quantScore);
  if (llm == null && quant == null) return null;
  const delta = llm != null && quant != null ? llm - quant : null;
  const conflict = !!(info.dualScore?.conflict
    || (delta != null && Math.abs(delta) > 15));
  return { llm, quant, delta, conflict };
}

/**
 * 用相邻两份日报（curr 较新、prev 较旧）推算列表差分
 */
function synthesizeNeighborDelta(curr, prev) {
  if (!curr || !prev) return null;
  const currScore = numOrNull(curr.score) ?? numOrNull(curr.dualScore?.llm);
  const prevScore = numOrNull(prev.score) ?? numOrNull(prev.dualScore?.llm);
  const currQuant = numOrNull(curr.quantInfo?.quantScore) ?? numOrNull(curr.dualScore?.quant);
  const prevQuant = numOrNull(prev.quantInfo?.quantScore) ?? numOrNull(prev.dualScore?.quant);
  const currPos = numOrNull(curr.positionRec?.targetPct);
  const prevPos = numOrNull(prev.positionRec?.targetPct);

  const scoreDelta = currScore != null && prevScore != null ? currScore - prevScore : null;
  const quantDelta = currQuant != null && prevQuant != null ? currQuant - prevQuant : null;
  const positionDelta = currPos != null && prevPos != null ? currPos - prevPos : null;

  const scoreMoved = scoreDelta != null && Math.abs(scoreDelta) >= 3;
  const quantMoved = quantDelta != null && Math.abs(quantDelta) >= 3;
  const posMoved = positionDelta != null && Math.abs(positionDelta) >= 5;
  const skipFineRead = !scoreMoved && !quantMoved && !posMoved;

  const prevLabel = prev.dateLabel || '上日';
  let headline;
  if (skipFineRead) {
    headline = `与${prevLabel}基本持平`;
  } else {
    const bits = [];
    if (scoreDelta != null) bits.push(`分${fmtSigned(scoreDelta)}`);
    if (quantDelta != null) bits.push(`量化${fmtSigned(quantDelta)}`);
    if (positionDelta != null) bits.push(`仓${fmtSigned(positionDelta)}点`);
    headline = `较${prevLabel}：${bits.join(' · ')}`;
  }

  return {
    headline,
    skipFineRead,
    scoreDelta,
    quantDelta,
    positionDelta,
    prevScore,
    currScore,
    prevQuant,
    currQuant,
    prevPositionPct: prevPos,
    currPositionPct: currPos,
    driverSummary: '',
    trackHint: '',
    source: 'neighbor',
  };
}

/**
 * 为按日期新→旧排列的 analyses 挂上 listDelta：
 * 优先 MD 较昨日；否则用相邻日报推算（旧报告也能看出趋势）
 */
function attachNeighborDeltas(analyses) {
  if (!Array.isArray(analyses) || !analyses.length) return analyses || [];
  return analyses.map((curr, i) => {
    const prev = analyses[i + 1] || null;
    const fromMd = curr.dayDelta || null;
    const synth = synthesizeNeighborDelta(curr, prev);
    let listDelta = null;
    if (fromMd && (fromMd.scoreDelta != null || fromMd.positionDelta != null || fromMd.headline)) {
      listDelta = { ...fromMd, source: fromMd.source || 'md' };
    } else if (synth) {
      listDelta = synth;
    }
    return { ...curr, listDelta };
  });
}

/**
 * 列表双打分行 HTML（调用方负责 esc；此处只拼结构，文本已是数字）
 */
function renderListDualHtml(dual, escFn) {
  const esc = typeof escFn === 'function' ? escFn : (s) => String(s);
  if (!dual) return '';
  const parts = [];
  if (dual.llm != null) parts.push(`<span class="rc-dual-llm">LLM <strong>${dual.llm}</strong></span>`);
  if (dual.quant != null) parts.push(`<span class="rc-dual-q">量化 <strong>${dual.quant}</strong></span>`);
  if (dual.delta != null) {
    const dStr = fmtSigned(dual.delta);
    const tone = dual.conflict ? 'conflict' : Math.abs(dual.delta) > 8 ? 'mild' : 'ok';
    parts.push(`<span class="rc-dual-d rc-dual-${tone}">Δ${esc(dStr)}</span>`);
  }
  if (!parts.length) return '';
  const conflictMark = dual.conflict ? '<span class="rc-dual-flag">分歧</span>' : '';
  return `<div class="rc-dual" title="双打分并排；分歧时不抬单侧权重">⚖️ ${parts.join('<span class="rc-dual-sep">·</span>')}${conflictMark}</div>`;
}

/**
 * 列表较上日差分 HTML
 */
function renderListDeltaHtml(dd, escFn) {
  const esc = typeof escFn === 'function' ? escFn : (s) => String(s);
  if (!dd) return '';
  const chips = [];
  const push = (label, delta, unit = '') => {
    if (delta == null) return;
    const sign = fmtSigned(delta);
    const tone = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    chips.push(`<span class="rc-dchip rc-d-${tone}">${label}${esc(sign)}${unit}</span>`);
  };
  push('分', dd.scoreDelta);
  push('量化', dd.quantDelta);
  push('仓', dd.positionDelta, '点');
  const skip = dd.skipFineRead ? ' skip' : '';
  const src = dd.source === 'neighbor' ? '<span class="rc-delta-src" title="由相邻日报推算">推算</span>' : '';
  const head = esc(dd.headline || (dd.skipFineRead ? '与上日持平' : '较上日有变化'));
  return `<div class="rc-delta${skip}">📅 ${head}${src}${chips.length ? `<span class="rc-dchips">${chips.join('')}</span>` : ''}</div>`;
}

/**
 * 仓位小标签
 */
function renderListPosHtml(pos, escFn) {
  const esc = typeof escFn === 'function' ? escFn : (s) => String(s);
  if (!pos || pos.targetPct == null) return '';
  return `<span class="rc-pos">仓 ${esc(String(pos.targetPct))}%</span>`;
}

function buildCardSearchBlob(info) {
  const dual = listDualScores(info);
  const dd = info.listDelta || info.dayDelta;
  return [
    info.filename,
    info.dateLabel,
    info.score,
    dual?.llm,
    dual?.quant,
    dual?.conflict ? '分歧' : '',
    info.advice?.label,
    info.qualityGate?.label,
    dd?.headline,
    info.positionRec?.targetPct != null ? `仓位${info.positionRec.targetPct}` : '',
  ].filter(Boolean).join(' ');
}

module.exports = {
  fmtSigned,
  listDualScores,
  synthesizeNeighborDelta,
  attachNeighborDeltas,
  renderListDualHtml,
  renderListDeltaHtml,
  renderListPosHtml,
  buildCardSearchBlob,
};
