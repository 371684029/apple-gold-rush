import { describe, it, expect } from 'vitest';
import { checkFreshness, gradeSource, crossValidate, validationSourcesFromPrices } from '../src/utils/source-rank';

describe('checkFreshness — 非法时间戳防御', () => {
  it('非法时间戳应判定为不新鲜并给出警告', () => {
    const r = checkFreshness('not-a-date');
    expect(r.fresh).toBe(false);
    expect(r.warning).toBeTruthy();
  });

  it('空字符串同样判定为不新鲜', () => {
    expect(checkFreshness('').fresh).toBe(false);
  });

  it('刚刚的时间应判定为新鲜', () => {
    expect(checkFreshness(new Date().toISOString()).fresh).toBe(true);
  });

  it('超过阈值的旧时间应判定为不新鲜', () => {
    const old = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    expect(checkFreshness(old, 4).fresh).toBe(false);
  });
});

describe('gradeSource', () => {
  it('权威来源识别为 A 级', () => {
    expect(gradeSource('上海黄金交易所')).toBe('A');
  });

  it('未知来源默认 B 级', () => {
    expect(gradeSource('某不知名网站')).toBe('B');
  });
});

describe('crossValidate — 单源不应标为 verified', () => {
  it('单源返回 single_source；B 级 50、A 级 72', () => {
    const r = crossValidate('london.price', [{
      value: 2650,
      source: 'Kitco',
      grade: 'B',
      timestamp: new Date().toISOString(),
    }]);
    expect(r.consensus).toBe('single_source');
    expect(r.confidence).toBe(50);
    expect(r.confidence).toBeLessThan(70);

    const a = crossValidate('london.price', [{
      value: 2650,
      source: 'gold-api.com',
      grade: 'A',
      timestamp: new Date().toISOString(),
    }]);
    expect(a.confidence).toBe(72);
  });

  it('validationSourcesFromPrices 合并主源与备用源', () => {
    const sources = validationSourcesFromPrices(
      { value: 2000, change: 0, source: 'A', sourceGrade: 'A', verifiedAt: 't1' },
      [{ value: 2005, change: 0, source: 'B', sourceGrade: 'B', verifiedAt: 't2' }],
    );
    expect(sources).toHaveLength(2);
    expect(crossValidate('london.price', sources).consensus).toBe('verified');
  });
});
