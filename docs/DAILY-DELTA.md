# 较昨日差分与研究卫生

定投用户痛点：每天日报「看起来都差不多」。本模块把**差分**与**研究卫生**做成可读入口，不承诺抬高点位准确率。

## 较昨日一览（`day-delta.ts`）

每次 `analysis` / Smart 路径会对比上一份报告：

| 项 | 说明 |
|----|------|
| 综合分 / 量化分 Δ | 相对昨日 |
| 建议仓位 Δ | 点（百分点） |
| 情景概率 Δ | ≥8% 算显著 |
| 驱动归因 | 伦敦金 / TIPS / 10Y / DXY / 主力分 |

- 无显著变化 → `skipFineRead`，headline 写「可跳过细读」
- 写入 MD `## 📅 较昨日一览`；可信度 TL;DR 首行强调差分
- Web 首页 hero + 今日一览面板 / 文章页首屏展示
- **历史日报每一行**：双打分（LLM · 量化 · Δ）+ 较上日差分芯片；旧报告无 MD 小节时用**相邻日报推算**（标「推算」）

## 因子 IC（`factor-ic.ts`）

```bash
npm run dev -- calibrate --ic --days 90
```

对历史 `quantFactors.normalizedScore` 与后 5 日收益做 Spearman；`|IC|<0.05` 且样本够 → 标「疑似失效」。**仅展示，不自动改权重。**

## Walk-forward（`walk-forward.ts`）

```bash
npm run dev -- calibrate --walk-forward --days 90
```

按日期对半切：前半训练 / 后半测试，比较分桶 MAE。测试明显变差 → 提示全样本命中率可能偏乐观。

## Regime 同阶段校准

MD「宏观阶段」节在有 `calibration.regimeTag` 时追加「同阶段校准」行（历史同阶段 5 日涨概率）。

## 反模式

- 不要把 IC / walk-forward 结果自动抬某一侧权重
- 不要在冲突日为了「看起来有变化」硬改仓位叙事
- KPI 仍是操作可信度与纪律，不是点位命中
