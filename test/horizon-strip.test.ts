import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildHorizonView,
  extractShortTerm,
  extractMidTerm,
  extractLongTerm,
  renderHorizonStrip,
} from '../web/horizon-strip.cjs';

const DOCS = path.resolve(__dirname, '../docs');

const MID_SECTION = `## 🧭 中期方向预期（1～3 个月）

中期（1～3 个月）结构偏多，综合 63/100。

| 期限 | 方向 | 强度 | 置信 | 操作倾向 | 建议 |
|------|------|------|------|----------|------|
| 1 个月 | 偏多 | 61 | moderate | 可加仓 | 回调至 MA50 附近可分批加波段仓 |
| 3 个月 | 偏多 | 63 | moderate | 可加仓 | 逐步把黄金仓位抬向计划上沿 |

## 下一节
`;

/** 新版长期表：含「配置档位」列 */
const LONG_SECTION_NEW = `## 🔭 长期方向预期（1 / 3 / 5 年 · 配置向）

| 期限 | 方向 | 趋势 | 强度 | 置信 | 配置档位 | 参考区间 |
|------|------|------|------|------|----------|----------|
| 1年 | 偏空 | 温和偏空 | 35 | moderate | 偏谨慎 | 参考名义累计约 -10.7% ~ +5.3% |
| 3年 | 偏空 | 温和偏空 | 40 | low | 偏谨慎 | （低置信不展示点位） |
| 5年 | 中性 | 宽幅震荡 | 48 | low | 中性 | （低置信不展示点位） |

## 下一节
`;

/** 2026-07 中旬的旧版长期表：没有「配置档位」列 */
const LONG_SECTION_OLD = `## 🔭 长期方向预期（1 / 3 / 5 年）

| 期限 | 方向 | 趋势 | 强度 | 置信度 | 名义回报区间（累计） |
|------|------|------|------|--------|---------------------|
| 1年 | 偏空 | 温和下行 | 31 | low | 名义累计约 -24.6% ~ -0.6%（1年，非承诺） |
| 3年 | 偏空 | 偏弱下行 | 30 | low | 名义累计约 -39% ~ -15%（3年，非承诺） |
| 5年 | 偏空 | 温和下行 | 31 | low | 名义累计约 -51.2% ~ -27.2%（5年，非承诺） |

## 下一节
`;

const SHORT_SECTION = `- 综合评分：**20–36/100**（中心 28，📉 偏空）

## 📦 当前仓位推荐

> 🔴 **极轻** · 相对计划仓 **26%** · 定投层 85% / 波段层 15%

- **结论**：维持纪律仓

## 下一节
`;

describe('短期档提取', () => {
  it('取评分、区间与仓位%', () => {
    const s = extractShortTerm(SHORT_SECTION)!;
    expect(s).toMatchObject({
      horizon: 'short',
      direction: 'bearish',
      score: 28,
      positionPct: 26,
      positionLabel: '极轻',
    });
  });

  it('无仓位小节时仍返回评分', () => {
    const s = extractShortTerm('- 综合评分：**68/100**（📈 偏多）')!;
    expect(s.score).toBe(68);
    expect(s.positionPct).toBeNull();
  });
});

describe('中期档提取', () => {
  it('解析 1 个月与 3 个月两行，以 3 个月为代表', () => {
    const m = extractMidTerm(MID_SECTION)!;
    expect(m.rows).toHaveLength(2);
    expect(m.score).toBe(63);
    expect(m.direction).toBe('bullish');
    expect(m.stance).toBe('可加仓');
  });

  it('无中期小节返回 null（旧日报）', () => {
    expect(extractMidTerm(LONG_SECTION_NEW)).toBeNull();
  });
});

describe('长期档提取', () => {
  it('新版表按表头取配置档位', () => {
    const l = extractLongTerm(LONG_SECTION_NEW)!;
    expect(l.rows).toHaveLength(3);
    expect(l.score).toBe(40);
    expect(l.stance).toBe('偏谨慎');
  });

  it('旧版表缺配置档位列时留空，不误取回报区间', () => {
    const l = extractLongTerm(LONG_SECTION_OLD)!;
    expect(l.score).toBe(30);
    // 按列序号硬取第 6 列会把「名义累计约 -39% ~ -15%」当成配置档位显示
    expect(l.stance).toBeNull();
  });

  it('以 3 年档为代表而非 1 年', () => {
    const l = extractLongTerm(LONG_SECTION_NEW)!;
    expect(l.score).toBe(40);
  });
});

describe('渲染', () => {
  const full = SHORT_SECTION + MID_SECTION + LONG_SECTION_NEW;

  it('三档齐备时输出三格', () => {
    const html = renderHorizonStrip(full);
    expect(html).toContain('horizon-strip');
    expect(html).toContain('短期');
    expect(html).toContain('中期');
    expect(html).toContain('长期');
    expect(html).toContain('建议仓位 <strong>26%</strong>');
  });

  it('缺中期档时给占位说明而非静默省略', () => {
    const html = renderHorizonStrip(SHORT_SECTION + LONG_SECTION_NEW);
    expect(html).toContain('hz-empty');
    expect(html).toContain('中期档尚未生成');
  });

  it('三档全缺时不输出空壳', () => {
    expect(renderHorizonStrip('# 无关文档\n正文')).toBe('');
  });

  it('说明三档口径不同、不一致是常态', () => {
    const html = renderHorizonStrip(full);
    expect(html).toContain('三档不一致是常态');
  });

  it('对 HTML 特殊字符转义', () => {
    const md = SHORT_SECTION.replace('极轻', '<img src=x>');
    const html = renderHorizonStrip(md);
    expect(html).not.toContain('<img src=x>');
  });
});

describe('仓库内真实日报', () => {
  const files = fs
    .readdirSync(DOCS)
    .filter(f => /^goldrush-analysis-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();

  it('每篇都至少能渲染出短期档', () => {
    for (const f of files) {
      const md = fs.readFileSync(path.join(DOCS, f), 'utf8');
      const view = buildHorizonView(md);
      expect(view.short, `${f} 短期档缺失`).not.toBeNull();
      expect(renderHorizonStrip(md), `${f} 决策条为空`).not.toBe('');
    }
  });

  it('最近的日报能同时给出短期与长期', () => {
    const latest = files[files.length - 1];
    const view = buildHorizonView(fs.readFileSync(path.join(DOCS, latest), 'utf8'));
    expect(view.short).not.toBeNull();
    expect(view.long).not.toBeNull();
  });
});
