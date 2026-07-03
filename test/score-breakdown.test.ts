import { describe, it, expect } from 'vitest';
import { buildScoreBreakdown, formatScoreBreakdownConsole, formatScoreBreakdownMarkdown } from '../src/utils/score-breakdown';

describe('buildScoreBreakdown', () => {
  it('展示三维度贡献与反驳修正链路', () => {
    const bd = buildScoreBreakdown(
      { score: 70 },
      { score: 65 },
      { score: 60 },
      { bearScore: 60, rebuttalStrength: 'moderate', adjustedScore: 64 },
    );

    expect(bd.initialScore).toBe(65);
    expect(bd.finalScore).toBe(64);
    expect(bd.rebuttal.roundedDelta).toBe(-1);
    expect(bd.dimensions).toHaveLength(3);
    expect(bd.dimensions[0].contribution).toBeCloseTo(70 / 3, 1);
  });

  it('强看空反驳应体现负向修正', () => {
    const bd = buildScoreBreakdown(
      { score: 59 },
      { score: 58 },
      { score: 60 },
      { bearScore: 71, rebuttalStrength: 'strong', adjustedScore: 49 },
    );
    expect(bd.rebuttal.roundedDelta).toBeLessThan(0);
    expect(bd.finalScore).toBeLessThan(bd.initialScore);
  });
});

describe('formatScoreBreakdownMarkdown', () => {
  it('输出可解析的评分构成表格', () => {
    const bd = buildScoreBreakdown(
      { score: 70 },
      { score: 65 },
      { score: 60 },
      { bearScore: 60, rebuttalStrength: 'moderate', adjustedScore: 64 },
    );
    const md = formatScoreBreakdownMarkdown(bd).join('\n');
    expect(md).toContain('## 📊 评分构成');
    expect(md).toContain('三维度均分');
    expect(md).toContain('反驳修正');
    expect(md).toContain('**64**');
  });
});

describe('formatScoreBreakdownConsole', () => {
  it('包含各步骤加减分说明', () => {
    const bd = buildScoreBreakdown(
      { score: 70 },
      { score: 65 },
      { score: 60 },
      { bearScore: 60, rebuttalStrength: 'moderate', adjustedScore: 64 },
    );
    const text = formatScoreBreakdownConsole(bd);
    expect(text).toContain('技术面');
    expect(text).toContain('强制反驳');
    expect(text).toContain('最终综合分');
  });
});
