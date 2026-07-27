# 决策质量改进清单（2026-07）

> 更新日期：2026-07-27  
> 目标：服务「短 / 中 / 长」买卖持决策——Web 可读、数据可靠、预测可核对、架构可维护。  
> 入口索引：本文件；细节分散在下列关联文档。

**相关**：

| 文档 | 覆盖 |
|------|------|
| [HORIZONS.md](./HORIZONS.md) | 短/中/长三档定义与不一致处理 |
| [POSITION-AND-TRACK.md](./POSITION-AND-TRACK.md) | 仓位推荐 + 预测对错（含中期 20 日轨） |
| [DUAL-SCORE.md](./DUAL-SCORE.md) | 双打分冲突与分轨校准 |
| [DATA-QUALITY.md](./DATA-QUALITY.md) | 零价禁写、锚定、门禁 |
| [DAILY-DELTA.md](./DAILY-DELTA.md) | 较昨日 Δ、IC、walk-forward OOS |
| [RELIABILITY.md](./RELIABILITY.md) | 操作可信度卡 |
| [LONG-TERM-OUTLOOK.md](./LONG-TERM-OUTLOOK.md) | 长期 1/3/5 年 |
| [ROADMAP-FINENG.md](./ROADMAP-FINENG.md) | 金融工程后续包与反模式 |
| `AGENTS.md` | 硬规则摘要（新会话必读） |

---

## 0. 怎么用这份清单

- **以后改评分 / 命中 / Web 决策面板**：先查本文件「已落地」与「刻意未做」，再改代码；阈值只动单一来源模块。  
- **验收**：`npm run lint` + `npm test`；涉及 Web 解析时再冒烟首页/文章页。  
- **KPI**：操作可信度与纪律（仓位上限、门禁、双分冲突），**不是**点位准确率。

---

## 1. 已落地待办总表

状态图例：✅ 已落地 · ⏸ 刻意未做 / 后续 · ⚠ 运维注意

### 1.1 量化评分（Signals）

| # | 待办 | 状态 | 要点 | 代码 / 测试 |
|---|------|------|------|-------------|
| Q1 | 缺因子按覆盖度重归一 | ✅ | 缺 dxy/us10y/tips/regime 不再把中性行情拖成偏空；产出 `coverage` / `missingFactors` / `staleFactors` | `indicators/quant-score.ts` · `test/quant-score.test.ts` |
| Q2 | 宏观序列过期剔除 | ✅ | `macroAgeDays` > 10 天剔除并重归一 | `price-series.ts` `pickMacroSeries` |
| Q3 | `REGIME_SIGNAL_MAP` 与 `detectMacroRegime` 对齐 | ✅ | 未知 tag 剔除，不伪装成中性 50 | `quant-score.ts` |
| Q4 | 波动率方向 / 横盘 RSI | ✅ | 高波动偏多避险；横盘 RSI→50 | `quant-score.ts` |

### 1.2 口径单一来源（Gates / 记账）

| # | 待办 | 状态 | 要点 | 代码 / 测试 |
|---|------|------|------|-------------|
| C1 | 方向阈值统一 | ✅ | **展示=记账**：≥58 涨、≤42 跌；中间中性**不计分母**。禁止再散落 55/45 | `decision-thresholds.ts` |
| C2 | 持平死区 | ✅ | ±0.1% 持平不计对错 | 同上 `FLAT_RETURN_PCT` |
| C3 | Wilson 95% CI + 样本门槛 | ✅ | 样本 &lt; 10 标注不具统计意义 | `wilsonInterval` / `MIN_HITRATE_SAMPLE` |
| C4 | 「永远看涨」基准 | ✅ | 命中率必须与实际上涨占比并列 | `beatsBaseline` / `prediction-track` |
| C5 | 前瞻收益窗口统一 | ✅ | 命中 / 校准 / IC **同一** `forwardReturnPct`（报告日收盘 → T 日后） | `forward-return.ts` |
| C6 | `test/` 纳入 lint | ✅ | `tsconfig.test.json` | — |

### 1.3 三期尺度（Portfolio / Explain）

| # | 待办 | 状态 | 要点 | 代码 / 测试 |
|---|------|------|------|-------------|
| H1 | 中期档 1～3 个月 | ✅ | 只吃慢变量；`mid_term_score` 落库；`updateFinal` 回写富化报告 | `mid-term-outlook.ts` · `ReportsRepo.updateFinal` |
| H2 | 首屏三期决策条 | ✅ | 短/中/长并排；中长期默认展开；宽表 overflow | `web/horizon-strip.cjs` |
| H3 | 区间版式评分解析 | ✅ | 兼容 `20–36/100（中心 28）` 与旧 `**评分**: N/100` | `web/report-extract.cjs` |
| H4 | 中期 20 日命中分轨 | ✅ | `PredictionTrackStats.midTerm`；不足样本显示「待积累」 | `prediction-track.ts` |
| H5 | 长期不做点位问责 | ✅ | 配置向；见 LONG-TERM-OUTLOOK | `long-term-outlook.ts` |

**仓位以短期档为准。** 中期/长期回答方向与配置，不直接下「今天下多少单」。

### 1.4 Web 架构（Explain）

| # | 待办 | 状态 | 要点 | 代码 / 测试 |
|---|------|------|------|-------------|
| W1 | 日报 `.meta.json` sidecar | ✅ | `analysis` 写 MD 时同步写出；`schemaVersion=1` | `report-meta.ts` · `web/report-meta.cjs` |
| W2 | server 优先读 meta | ✅ | 评分/量化/仓位/建议/门禁/双分/三期条；失败再回落 MD 正则 | `server.cjs` · `horizon-strip.cjs` |
| W3 | 双分冲突文案 | ✅ | `dual_conflict` →「双分分歧决定」，不空喊「双体系不一致」 | 既有 `plain-advice` / Web |

**运维注意**：历史日报需重新 `analysis --md`（或 Smart 路径写 MD）才会生成 sidecar；旧报告仍靠正则。

### 1.5 数据卫生（Signals）

| # | 待办 | 状态 | 要点 | 代码 / 测试 |
|---|------|------|------|-------------|
| D1 | FRED `timestamp` = 观测日 | ✅ | `YYYY-MM-DDT00:00:00.000Z`，不用 `new Date()`，避免陈旧利率伪装「刚刚验证」 | `live-anchors.ts` `fetchFredLatest` |
| D2 | `upsertBackfill` sanitize | ✅ | 与 `upsert` 一致：0/无效不入库；首次脏值无法靠 COALESCE 挡 | `GoldPricesRepo` · `test/gold-prices-sanitize.test.ts` |
| D3 | `institutional_flows` COALESCE | ✅ | 刷新 CFTC 不清掉同日 GLD/央行 | `institutional-flows` repo 测试 |
| D4 | CFTC 损坏单元格不补 0 | ✅ | 缺字段 → null/中性，不编造 | CFTC 解析路径 |

### 1.6 研究卫生（校准）

| # | 待办 | 状态 | 要点 | 代码 / 测试 |
|---|------|------|------|-------------|
| R1 | Walk-forward 训练/测试 MAE | ✅ | `calibrate --walk-forward` | `walk-forward.ts` |
| R2 | 测试窗 OOS 方向命中 | ✅ | `computeOosHitStats`：测试窗独立记账 + CI + 永远看涨基准 | 同上 · `calibrate.ts` |
| R3 | 因子 IC | ✅ | `calibrate --ic`；仅展示不自动改权 | `factor-ic.ts` |

---

## 2. 刻意未做 / 后续（勿擅自「补全」）

| 项 | 原因 | 可能入口 |
|----|------|----------|
| 校准偏移真正 OOS 应用 | 当前 walk-forward 是测试窗**直接记账**命中，不是「训练估偏移 → 应用到测试再评」 | ROADMAP 包 F 加深 |
| 中期命中大样本宣称 | 需 `mid_term_score` 积累后才有统计意义；样本不足时只写「待积累」 | `prediction-track` |
| 历史 MD 批量补写 meta | 旧报告靠正则足够；批量重跑 analysis 成本高 | 运维按需 |
| 冲突时抬某一侧权重 | 反模式；冲突应收紧仓位 | `DUAL-SCORE` / ROADMAP |
| 以点位准确率为 KPI | 反模式 | ROADMAP §5 |
| 事件传导进量化权重 | 暂定 `event_heat=0`，仅 Explain | `USER-VALUE.md` |
| 纸面 MaxDD / 新鲜度 SLA / 情景 Brier | 规划中 | ROADMAP 包 B/D/G |

---

## 3. 架构约定（以后改代码先守这些）

### 3.1 Signals → Gates → Portfolio → Explain

新功能先标明落在哪一层，避免把 Explain 文案写进 Signals，或把 Gates 阈值散落多处。

```
Signals（量化/中期/长期因子、锚定、flow）
    ↓
Gates（门禁、双分冲突、口径阈值、数据新鲜度）
    ↓
Portfolio（仓位推荐、平滑、上限）
    ↓
Explain（MD / Web / meta sidecar / 三期条 / 可信度 TL;DR）
```

### 3.2 单一来源模块（禁止复制阈值）

| 内容 | 唯一模块 |
|------|----------|
| 方向 / 持平 / 命中 / Wilson / 基准 | `src/utils/decision-thresholds.ts` |
| 前瞻收益窗口 | `src/utils/forward-return.ts` |
| 统一操作建议文案 | `resolveOperationalAdvice`（`plain-advice.ts`） |
| 日报机器可读契约 | `src/utils/report-meta.ts` ↔ `web/report-meta.cjs` |
| MD 正则回落解析 | `web/report-extract.cjs` |
| 三期条视图 | `web/horizon-strip.cjs`（优先 meta） |

### 3.3 meta sidecar 契约摘要

路径：与 MD 同目录 `goldrush-analysis-YYYY-MM-DD.meta.json`  
`schemaVersion` 必须为 `1`；不匹配则 Web **整份忽略**并回落正则。

关键字段：`score` / `direction` / `scoreLow`/`scoreHigh` / `quantScore` / `midTermScore` / `position` / `advice` / `gate` / `dual` / `reliability` / `short`/`mid`/`long`。

`reliability.level` 对应 `ReliabilityCard.tier`（写 meta 时做映射）。

### 3.4 量化覆盖度

缺因子必须**剔除并重归一**，禁止用「缺席=0 贡献」把分数往中性以下拽。覆盖度 &lt; 75% 应在报告提示。

### 3.5 主力表与回填

- `institutional_flows.upsert`：一律 COALESCE，后写源不得清空先写源。  
- `gold_prices.upsert` / `upsertBackfill`：均 sanitize；0 不当有效价。  
- CFTC / GLD / PBOC：无数据 → null/中性，**不编造、不补 0**。

---

## 4. 验收清单（本轮回归）

```bash
npm run lint
npm test
# 纯本地冒烟（无需 LLM）
npm run dev -- history
npm run dev -- calibrate --walk-forward --days 90
```

| 检查点 | 期望 |
|--------|------|
| 缺宏观因子时量化分 | 覆盖度下降，分数不系统性偏空 |
| 命中率展示 | 带 Wilson CI、样本门槛、永远看涨基准 |
| 中期 MD / JSON | 有 `midTerm` 行；无样本时「待积累」 |
| 新 analysis --md | 同目录出现 `.meta.json`；Web 决策面板不依赖版式 |
| FRED 锚定 | `timestamp` 日期等于观测日 |
| upsertBackfill(0) | 库内为 NULL，不是 0 |

---

## 5. 提交轨迹（便于 git blame / 回滚）

自评估优化起，相关主线 commit（旧→新，截至 `3f3c60d`）：

1. `fix(quant)`：缺因子重归一 + regime/波动率/RSI  
2. `feat(accuracy)`：decision-thresholds + Wilson CI + 永远看涨基准  
3. `fix(web)`：区间版式评分解析  
4. `feat(mid-term)`：1～3 个月中期档 + `updateFinal`  
5. `feat(web)`：首屏三期决策条  
6. `fix(data)`：forward-return 统一 + COALESCE flows + CFTC 不补零  
7. `docs`：HORIZONS + AGENTS 约定  
8. `feat`：meta sidecar + 中期命中 + FRED 观测日 + walk-forward OOS  

分支曾用：`cursor/gold-decision-quality-a467`；已合入 `main`。

---

## 6. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-27 | 初稿：汇总决策质量轮次全部待办、刻意未做、架构约定与验收 |
