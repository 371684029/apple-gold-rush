// 文章页折叠：按 h2 分节、反驳列表折叠、默认展开策略

/**
 * 默认展开的章节关键词。
 * 用户的核心诉求是「短/中/长分别怎么办」，因此三档方向小节都默认展开；
 * 长期档此前被折叠，想看多年配置结论要先点开，等于把结论藏起来。
 */
const OPEN_SECTION_KEYS = [
  '短期策略',
  '中长期策略',
  '情景分析',
  '中期方向',
  '长期方向',
];

/** 不再单独列出；默认全部折叠，只通过 OPEN_SECTION_KEYS 白名单放行 */
const COLLAPSED_SECTION_KEYS = [];

function sectionKind(title) {
  const t = String(title || '');
  if (t.includes('强制反驳')) return 'rebuttal';
  if (t.includes('情景分析')) return 'scenarios';
  if (t.includes('短期策略')) return 'short-strategy';
  if (t.includes('中长期策略')) return 'mid-strategy';
  if (t.includes('尾部风险')) return 'tail-risk';
  if (t.includes('中期方向')) return 'mid-term';
  if (t.includes('长期方向')) return 'long-term';
  if (t.includes('四维度')) return 'dimensions';
  if (t.includes('裁决')) return 'judge';
  if (t.includes('历史相似')) return 'similar';
  if (t.includes('宏观')) return 'macro';
  return 'other';
}

function shouldOpenByDefault(title) {
  const t = String(title || '');
  return OPEN_SECTION_KEYS.some(k => t.includes(k));
}

/**
 * 将 marked 输出的 HTML 按 h2 包进 <details>
 * @param {string} html
 * @param {{ title: string, id: string }[]} tocItems
 * @returns {string}
 */
function wrapH2Sections(html, tocItems) {
  if (!html || !tocItems.length) return html;

  const parts = html.split(/(?=<h2[\s>])/i);
  let h2Idx = 0;
  const out = [];

  for (const part of parts) {
    if (!/^<h2[\s>]/i.test(part)) {
      out.push(part);
      continue;
    }

    const item = tocItems[h2Idx];
    const id = item?.id || `sec-${h2Idx}`;
    const title = item?.title || `章节 ${h2Idx + 1}`;
    const open = shouldOpenByDefault(title);
    const kind = sectionKind(title);
    h2Idx++;

    const body = part.replace(/<h2([^>]*)>/i, (_m, attrs) => {
      const cleaned = String(attrs).replace(/\s*id\s*=\s*["'][^"']*["']/i, '');
      return `<h2 class="md-sec-h2"${cleaned}>`;
    });

    // 节内 h2 对已展开的 details 多余，藏起来用 summary 当标题
    const bodyWithoutDupH2 = body.replace(
      /<h2 class="md-sec-h2"[^>]*>[\s\S]*?<\/h2>/i,
      '',
    );

    out.push(
      `<details class="md-section" data-sec-id="${id}" data-sec-kind="${kind}" id="${id}"${open ? ' open' : ''}>` +
      `<summary class="md-section-summary">` +
      `<span class="md-sec-title">${escapeHtml(title)}</span>` +
      `<span class="md-sec-hint" aria-hidden="true"></span>` +
      `</summary>` +
      `<div class="md-section-body">${bodyWithoutDupH2}</div></details>`,
    );
  }

  return out.join('');
}

/**
 * 强制反驳：看空论据 / 看多漏洞 默认只露前 keep 条
 * @param {string} html
 * @param {number} keep
 */
function collapseRebuttalLists(html, keep = 2) {
  return html.replace(
    /<details class="md-section"[^>]*data-sec-kind="rebuttal"[^>]*>([\s\S]*?)<\/details>/,
    (full) => {
      return full.replace(
        /(<div class="md-section-body">)([\s\S]*?)(<\/div>\s*<\/details>)/,
        (_m, head, body, tail) => head + collapseLongListItems(body, keep) + tail,
      );
    },
  );
}

/**
 * 只折叠「叶子列表」（内部不再含 ul/ol），避免嵌套列表被拆坏。
 * 从内到外多次扫描，直到没有可折叠列表。
 */
function collapseLongListItems(bodyHtml, keep) {
  let html = bodyHtml;
  let guard = 0;
  while (guard++ < 8) {
    let changed = false;
    html = html.replace(/<(ul|ol)(\s[^>]*)?>((?:(?!<\/?(?:ul|ol)\b)[\s\S])*)<\/\1>/gi, (m, tag, attrs, inner) => {
      // 已是叶子列表（inner 不含嵌套列表标签）
      const items = inner.match(/<li[\s>][\s\S]*?<\/li>/gi) || [];
      if (items.length <= keep) return m;
      changed = true;
      const visible = items.slice(0, keep).join('');
      const hidden = items.slice(keep).join('');
      const attrStr = attrs || '';
      return (
        `<${tag}${attrStr}>${visible}</${tag}>` +
        `<details class="md-more-list"><summary>还有 ${items.length - keep} 条，点击展开</summary>` +
        `<${tag}${attrStr}>${hidden}</${tag}></details>`
      );
    });
    if (!changed) break;
  }
  return html;
}

/**
 * 情景分析表：过长单元格折叠
 * @param {string} html
 */
function collapseScenarioTableCells(html) {
  return html.replace(
    /<details class="md-section"[^>]*data-sec-kind="scenarios"[^>]*>([\s\S]*?)<\/details>/,
    (full) => full.replace(/<td>([\s\S]*?)<\/td>/gi, (_m, cell) => {
      const text = cell.replace(/<[^>]+>/g, '').trim();
      if (text.length < 72) return `<td>${cell}</td>`;
      const short = escapeHtml(text.slice(0, 42)) + '…';
      return `<td><details class="md-cell-more"><summary>${short}</summary><div class="md-cell-full">${cell}</div></details></td>`;
    }),
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 完整后处理管线
 * @param {string} contentHtml marked 输出
 * @param {{ title: string, id: string }[]} tocItems
 */
function processArticleContent(contentHtml, tocItems) {
  let html = wrapH2Sections(contentHtml, tocItems);
  html = collapseRebuttalLists(html, 2);
  html = collapseScenarioTableCells(html);
  return html;
}

module.exports = {
  OPEN_SECTION_KEYS,
  COLLAPSED_SECTION_KEYS,
  shouldOpenByDefault,
  sectionKind,
  wrapH2Sections,
  collapseRebuttalLists,
  collapseScenarioTableCells,
  processArticleContent,
};
