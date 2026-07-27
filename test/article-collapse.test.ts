import { describe, it, expect } from 'vitest';
import {
  processArticleContent,
  shouldOpenByDefault,
} from '../web/article-collapse.cjs';

describe('article-collapse', () => {
  it('策略/情景默认展开，反驳/尾部默认折叠', () => {
    expect(shouldOpenByDefault('⏱️ 短期策略（日线级别）')).toBe(true);
    expect(shouldOpenByDefault('📅 中长期策略（周线级别）')).toBe(true);
    expect(shouldOpenByDefault('⚡ 情景分析')).toBe(true);
    expect(shouldOpenByDefault('🔴 强制反驳')).toBe(false);
    expect(shouldOpenByDefault('⚠️ 尾部风险')).toBe(false);
  });

  it('中期与长期方向默认展开——多期限结论不该藏在折叠里', () => {
    expect(shouldOpenByDefault('🧭 中期方向预期（1～3 个月）')).toBe(true);
    expect(shouldOpenByDefault('🔭 长期方向预期（1 / 3 / 5 年 · 配置向）')).toBe(true);
  });

  it('按 h2 包 details，并折叠反驳长列表', () => {
    const html = [
      '<h2>⚡ 情景分析</h2><p>情景</p>',
      '<h2>🔴 强制反驳</h2><ul>',
      '<li>论据1</li><li>论据2</li><li>论据3</li><li>论据4</li>',
      '</ul>',
      '<h2>⏱️ 短期策略（日线级别）</h2><p>观望</p>',
    ].join('');
    const toc = [
      { title: '⚡ 情景分析', id: 'sec-0' },
      { title: '🔴 强制反驳', id: 'sec-1' },
      { title: '⏱️ 短期策略（日线级别）', id: 'sec-2' },
    ];
    const out = processArticleContent(html, toc);
    expect(out).toContain('data-sec-kind="scenarios"');
    expect(out).toContain('data-sec-kind="rebuttal"');
    expect(out).toContain('data-sec-kind="short-strategy"');
    expect(out).toMatch(/id="sec-0"[^>]*\sopen/);
    expect(out).toMatch(/id="sec-2"[^>]*\sopen/);
    expect(out).not.toMatch(/id="sec-1"[^>]*\sopen/);
    expect(out).toContain('还有 2 条，点击展开');
  });
});
