import { describe, it, expect } from 'vitest';
import {
  applyCalibrationScore,
  computeCalibrationOffset,
  directionFromScore,
} from '../src/utils/calibration-adjust';

describe('computeCalibrationOffset', () => {
  it('样本不足时不偏移', () => {
    expect(computeCalibrationOffset(65, 0.58, 2)).toBe(0);
  });

  it('偏乐观区间下调分数', () => {
    // 60-70 中点 65，实际涨概率 40% → offset = 40-65 = -25 → cap -8
    expect(computeCalibrationOffset(65, 0.4, 12)).toBe(-8);
  });

  it('偏保守区间小幅上调', () => {
    // 30-50 中点 40，实际涨概率 55% → offset = 15 → cap +3
    expect(computeCalibrationOffset(45, 0.55, 10)).toBe(3);
  });

  it('5-9 样本折半偏移', () => {
    expect(computeCalibrationOffset(62, 0.55, 7)).toBe(-5);
  });
});

describe('applyCalibrationScore', () => {
  it('无校准时返回原分', () => {
    const r = applyCalibrationScore(47, { historicalAccuracy: null, sampleSize: 2, systematicBias: '样本不足' });
    expect(r.calibratedScore).toBe(47);
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('校准样本不足');
  });

  it('regime 样本优先用于偏移', () => {
    const r = applyCalibrationScore(65, {
      historicalAccuracy: 0.7,
      sampleSize: 20,
      systematicBias: '校准良好',
      regimeHistoricalAccuracy: 0.4,
      regimeSampleSize: 5,
      regimeSystematicBias: '偏乐观',
    });
    expect(r.offset).toBeLessThan(0);
    expect(r.applied).toBe(true);
  });

  it('应用偏移并钳制 0-100', () => {
    const r = applyCalibrationScore(47, { historicalAccuracy: 0.25, sampleSize: 10, systematicBias: '偏乐观' });
    expect(r.offset).toBeLessThan(0);
    expect(r.calibratedScore).toBeGreaterThanOrEqual(0);
    expect(r.applied).toBe(true);
  });
});

describe('directionFromScore', () => {
  it('阈值与长期展望一致', () => {
    expect(directionFromScore(60)).toBe('bullish');
    expect(directionFromScore(40)).toBe('bearish');
    expect(directionFromScore(50)).toBe('neutral');
  });
});
