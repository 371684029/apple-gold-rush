import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractScore, extractQuantScore, extractQuantCoverage } from '../web/report-extract.cjs';

const DOCS = path.resolve(__dirname, '../docs');

function analysisFiles(): string[] {
  return fs
    .readdirSync(DOCS)
    .filter(f => /^goldrush-analysis-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();
}

describe('extractScore 版式兼容', () => {
  it('单值版式', () => {
    const r = extractScore('- 综合评分：**68/100**（📈 偏多）');
    expect(r).toMatchObject({ score: 68, direction: 'bullish', isBand: false });
  });

  it('区间版式取中心值', () => {
    const r = extractScore('- 综合评分：**20–36/100**（中心 28，📉 偏空）');
    expect(r).toMatchObject({ score: 28, direction: 'bearish', low: 20, high: 36, isBand: true });
  });

  it('区间版式未写中心时取中点', () => {
    const r = extractScore('- 综合评分：**20–36/100**（📉 偏空）')!;
    expect(r.score).toBe(28);
    expect(r.isBand).toBe(true);
  });

  it('兼容 ASCII 连字符与全角波浪号', () => {
    expect(extractScore('综合评分：**20-36/100**（中心 30）')!.score).toBe(30);
    expect(extractScore('综合评分：**20～36/100**（中心 30）')!.score).toBe(30);
  });

  it('2026-06 旧版式（**评分**: N/100 + 独立方向行）', () => {
    const md = '## 🎯 综合研判\n\n**评分**: 37/100\n**方向**: 📉 看空\n';
    expect(extractScore(md)).toMatchObject({ score: 37, direction: 'bearish' });
  });

  it('无评分时返回 null', () => {
    expect(extractScore('# 标题\n没有评分')).toBeNull();
  });
});

describe('仓库内全部日报都能解析出评分', () => {
  const files = analysisFiles();

  it('存在日报样本', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // 区间版式曾导致最近 4 篇日报在网页上完全不显示决策面板，
  // 这里对每一篇实际日报断言，防止再次静默回归。
  for (const f of files) {
    it(`${f} 可解析`, () => {
      const md = fs.readFileSync(path.join(DOCS, f), 'utf8');
      const r = extractScore(md);
      expect(r, `${f} 解析失败，网页决策面板会整体消失`).not.toBeNull();
      expect(r!.score).toBeGreaterThanOrEqual(0);
      expect(r!.score).toBeLessThanOrEqual(100);
    });
  }
});

describe('extractQuantScore', () => {
  it('量化 + LLM 并排', () => {
    const r = extractQuantScore('- 🔢 量化评分: **63/100** | LLM: 67/100 | ⚠️ LLM偏高 +4');
    expect(r).toMatchObject({ quantScore: 63, llmScore: 67 });
  });

  it('区间写法取上界数字', () => {
    const r = extractQuantScore('- 🔢 量化评分: **40-45/100** | LLM: 20-28/100');
    expect(r).toMatchObject({ quantScore: 45, llmScore: 28 });
  });

  it('仅量化分', () => {
    expect(extractQuantScore('- 🔢 量化评分: 63')!.quantScore).toBe(63);
  });

  it('无量化分返回 null', () => {
    expect(extractQuantScore('无关文本')).toBeNull();
  });
});

describe('extractQuantCoverage', () => {
  it('从因子表合计行取覆盖度', () => {
    expect(extractQuantCoverage('| **合计** | | 70% | **36** |')).toBe(70);
  });

  it('无因子表返回 null', () => {
    expect(extractQuantCoverage('无表格')).toBeNull();
  });
});
