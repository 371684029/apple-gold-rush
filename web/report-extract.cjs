/**
 * 日报 Markdown → 结构化决策字段。
 *
 * server.cjs 原先内联的 extractScore 只认 `综合评分：**68/100**`，
 * 而报告自 2026-07-17 起改用区间格式 `**20–36/100**（中心 28，📉 偏空）`。
 * 解析失败时 renderPredictionDashboard 直接 return ''，
 * 结果是最近的日报在网页上完全看不到评分/仓位/操作建议。
 *
 * 纯函数，供 server.cjs 与单测共用。
 */

'use strict';

/** 各种破折号统一成 ASCII '-'，便于正则匹配 */
function normalizeDashes(s) {
  return String(s).replace(/[–—−~～]/g, '-');
}

function dirFromText(text) {
  const t = String(text || '');
  if (t.includes('多') || t.includes('涨')) return 'bullish';
  if (t.includes('空') || t.includes('跌')) return 'bearish';
  return 'neutral';
}

/**
 * 提取综合评分与方向，兼容两种写法：
 *   单值：综合评分：**68/100**（📈 偏多）
 *   区间：综合评分：**20-36/100**（中心 28，📉 偏空）
 *
 * 区间格式取「中心」值；没写中心时取区间中点。
 * 返回 { score, direction, low, high, isBand }，无法解析返回 null。
 */
function extractScore(md) {
  const text = normalizeDashes(md);

  // 区间优先：低-高/100，随后可能带「中心 N」
  const band = text.match(
    /综合评分[：:]\s*\*{0,2}(\d+)\s*-\s*(\d+)\/100\*{0,2}\s*[（(]?([^）)]*)[）)]?/,
  );
  if (band) {
    const low = parseInt(band[1], 10);
    const high = parseInt(band[2], 10);
    const note = band[3] || '';
    const centerMatch = note.match(/中心\s*(\d+)/);
    const score = centerMatch ? parseInt(centerMatch[1], 10) : Math.round((low + high) / 2);
    return { score, direction: dirFromText(note), low, high, isBand: true };
  }

  const single = text.match(/综合评分[：:]\s*\*{0,2}(\d+)\/100\*{0,2}[\s（(]*([^）)]*)[）)]?/);
  if (single) {
    const score = parseInt(single[1], 10);
    return { score, direction: dirFromText(single[2]), low: null, high: null, isBand: false };
  }

  // 2026-06 及更早的旧版式：## 🎯 综合研判 下的 `**评分**: 37/100`
  const legacy = text.match(/\*\*评分\*\*[：:]\s*(\d+)\/100/);
  if (legacy) {
    const score = parseInt(legacy[1], 10);
    // 旧版式方向单独成行：**方向**: 偏空 / 看多 等
    const dirLine = text.match(/\*\*方向\*\*[：:]\s*([^\n]*)/);
    return {
      score,
      direction: dirLine ? dirFromText(dirLine[1]) : dirFromText(''),
      low: null,
      high: null,
      isBand: false,
    };
  }

  return null;
}

/**
 * 提取量化分对比行：`- 🔢 量化评分: **63/100** | LLM: 67/100`
 * 也兼容区间写法与仅有量化分的写法。
 */
function extractQuantScore(md) {
  const text = normalizeDashes(md);

  const pair = text.match(
    /量化评分[：:]\s*\*{0,2}(?:\d+\s*-\s*)?(\d+)\/100\*{0,2}\s*\|\s*LLM[：:]\s*\*{0,2}(?:\d+\s*-\s*)?(\d+)\/100/,
  );
  if (pair) {
    return { quantScore: parseInt(pair[1], 10), llmScore: parseInt(pair[2], 10), diff: null };
  }

  const alt = text.match(/🔢\s*量化评分[：:]\s*\*{0,2}(?:\d+\s*-\s*)?(\d+)/);
  if (alt) {
    return { quantScore: parseInt(alt[1], 10), llmScore: null, diff: null };
  }

  return null;
}

/** 量化因子覆盖度：`| **合计** | | 70% | ... |`，返回 0–100 或 null */
function extractQuantCoverage(md) {
  const m = String(md).match(/\|\s*\*{0,2}合计\*{0,2}\s*\|[^|]*\|\s*(\d+)%\s*\|/);
  return m ? parseInt(m[1], 10) : null;
}

module.exports = {
  extractScore,
  extractQuantScore,
  extractQuantCoverage,
  normalizeDashes,
};
