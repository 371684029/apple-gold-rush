# 当前仓位推荐 + 历史预测对错

> 更新：2026-07-16  
> 目标：日报 Web **可操作**（相对计划仓）+ **可核对**（历史方向对错统计），不是账户杠杆或业绩承诺。

**相关**：`IMPROVEMENTS.md` 第十一轮、`docs/DUAL-SCORE.md`、`docs/DATA-QUALITY.md`、`AGENTS.md`、`README`、**`docs/ROADMAP-FINENG.md`（仓位 v2：波动/平滑/回撤规划）**。

---

## 1. 产品定义

| 做 | 不做 |
|----|------|
| 相对「黄金计划仓」=100% 的目标占比 | 总资产杠杆倍数、绝对手数 |
| 定投层 / 波段层拆分 + 人话操作 | 保证短期收益 |
| 门禁红 / 双分冲突时收紧仓位 | 与双分冲突时抬某一侧权重 |
| 历史 5 日方向命中、分桶、明细表 | 宣传「准确率保证」或投资业绩 |

### 用户一句话

- **仓位**：今天相对我计划的黄金仓，该偏轻、标配还是偏积极？  
- **对错**：过去一段时间系统「看涨/看跌」到底对了几次？

---

## 2. 当前仓位推荐

### 2.1 模块

| 项 | 值 |
|----|-----|
| 源码 | `src/utils/position-recommend.ts` |
| 入口 | `recommendPosition(input)` |
| 输出格式 | `formatPositionConsole` / `formatPositionMarkdown` |
| 接入 | `analysis.ts`（主路径）→ `report-md.ts` extras |
| MD 标题 | `## 📦 当前仓位推荐` |

### 2.2 输入

| 字段 | 含义 |
|------|------|
| `llmScore` | 展示用 LLM 综合分 |
| `quantScore` | 量化分（有则与 LLM 取均值作参考分） |
| `dataActionable` | 数据门禁是否允许操作 |
| `dualPolicy` | 双打分策略（如 `hold_on_conflict`） |
| `flowScore` | 主力综合分（可选） |
| `longTermStance` | 长期 3 年档优先：overweight / neutral / underweight |
| `consistencyLevel` | 四维一致性 strong / moderate / weak |
| `direction` | 综合方向（辅助文案） |

### 2.3 计算要点

1. **基准仓位**：由参考分映射  
   - ≤25 → 25% … ≤55 → 55% … ≤75 → 75% … 更高 → 85%  
2. **约束（取更严）**  
   - 门禁红档（`dataActionable === false`）：**上限 35%**  
   - 双分冲突（`hold_on_conflict`）：**上限 50%**  
   - 四维弱一致：**上限 50%**  
3. **微调**  
   - 主力偏空（flow≤35）：−8；偏多（≥65）：+5  
   - 长期 underweight −5 / overweight +5  
4. **夹紧** 最终 **15%–90%**  
5. **定投层 vs 波段层**（占 target 的比例）  
   - 越谨慎定投层越高（如 target≤40 → 定投层 85%）；红档/冲突时定投层 ≥85%  
6. **标签**  
   - 极轻 / 偏轻 / 标配 / 偏积极 / 积极  
   - tilt：`reduce` | `hold` | `add`

### 2.4 展示

| 渠道 | 行为 |
|------|------|
| CLI | analysis 编排完成后打印仓位块 |
| Markdown | 双分 / 因子表后嵌入小节 |
| Web 首页 | 解析最新日报 MD；若无小节则**按分数粗推**（标注旧报告） |
| Web 文章 | 仪表盘内 `pos-panel`；正文重复小节会被 `stripDashboardDuplicates` 去掉 |

---

## 3. 历史预测对错

### 3.1 模块

| 项 | 值 |
|----|-----|
| 源码 | `src/utils/prediction-track.ts` |
| 构建 | `buildPredictionTrackStats(db, windowDays=90, T=5)` |
| 落盘 | `savePredictionTrackJson` → **`docs/goldrush-stats-latest.json`** |
| 输出格式 | `formatPredictionTrackConsole` / `formatPredictionTrackMarkdown` |
| 接入 | 每次完整 `analysis` 刷新 JSON + 写入 MD |
| MD 标题 | `## 📊 历史预测对错` |
| 复用 | `CalibrationRepo.computeDualTrackHitStats`（与 `calibrate` 同规则） |

### 3.2 标签规则

| 规则 | 说明 |
|------|------|
| 预测方向 | 分数 **&gt;55 → 涨**，**&lt;45 → 跌**，中间不计入命中率 |
| 实际 | 报告日伦敦收盘 vs 约 **T=5** 个有效交易日后；\|涨跌\|≤0.1% 视为持平，**不计对错** |
| 样本 | 近 `windowDays`（默认 90）条有有效 `london_close` 的报告 |

### 3.3 统计字段（JSON / Web）

| 字段 | 含义 |
|------|------|
| `llm.hitRate` / `quant.hitRate` | 方向命中率 % 与 hits/total |
| `highScoreUpRate` | LLM≥60 时 5 日实际上涨概率 |
| `lowScoreUpRate` | LLM≤40 时 5 日实际上涨概率 |
| `conflictDays` | 双分冲突日数 |
| `conflictFollowQuantHits` / `…LlmHits` | 冲突日跟量化 / 跟 LLM 谁对 |
| `buckets[]` | 评分区间 → 样本、涨概率、平均涨幅 |
| `recent[]` | **整窗**按日明细（hit / miss / pending / flat）+ `alignPct` 顺/逆预测 + `vsBucketPct` 相对同档；MD 表仍只展示近 12 条 |
| `summary` | 一行人话摘要 |

### 3.4 展示

| 渠道 | 行为 |
|------|------|
| CLI | analysis 后打印摘要 + 近况 |
| Markdown | 关键统计表 + 分桶 + 最近明细 |
| Web 首页 | 读 `goldrush-stats-latest.json`：统计卡 + `pred-stats-panel`；**历史列表每一行**挂当日对错/顺逆预测/同档偏差 |
| Web 文章 | 同面板嵌在预测仪表盘下方；MD 正文重复节可剥离 |

**注意**：仅部署 `server.cjs` 而不跑 analysis 时，需已有 `docs/goldrush-stats-latest.json`；运维可在项目根用已编译模块单独刷一次 stats（见 §5）。

---

## 4. Web（`server.cjs`）

| 函数 / 行为 | 作用 |
|-------------|------|
| `extractPositionRecommend(md)` | 从 MD「当前仓位推荐」小节抽 target% / 标签 / 定投层 |
| `loadPredictionStats()` | 读 `docs/goldrush-stats-latest.json` |
| `renderPositionPanel` | 仓位条 + 标签 + 结论 |
| `renderPredictionStatsPanel` | 命中网格 + 分桶/明细 details |
| 首页 stats 卡 | 在偏多/均分旁追加 LLM命中、量化命中、建议仓位 |
| 旧报告回退 | 无仓位小节时按 score 粗推档位，headline 标明「旧报告推算」 |

---

## 5. 运维与命令

```bash
# 完整路径：写 MD + 刷新 stats JSON + 仓位小节
node dist/index.js analysis --md

# 仅刷新预测对错 JSON（需已 build，在项目根）
node --input-type=module -e "
import { getDb } from './dist/db/index.js';
import { buildPredictionTrackStats, savePredictionTrackJson } from './dist/utils/prediction-track.js';
const s = buildPredictionTrackStats(getDb(), 90, 5);
console.log(savePredictionTrackJson(s), s.summary);
"

# Web（生产常 :80）
node server.cjs
```

单元测试：

- `test/position-recommend.test.ts`
- `test/prediction-track.test.ts`
- `test/report-md.test.ts`（嵌入小节）

---

## 6. 与其它模块的关系

```
data-quality-gate  ──红档──► 仓位上限 35% + 操作关闭
dual-score         ──冲突──► 仓位上限 50% + 操作弃权
long-term-outlook  ──stance─► 仓位 ±5
flow / 一致性      ─────────► 仓位微调 / 上限
analysis_reports + gold_prices ─► 预测对错命中与分桶
calibrate 分轨     ─────────► 同标签规则；面板是「常看」版摘要
```

| 文档 | 交叉点 |
|------|--------|
| [DUAL-SCORE.md](./DUAL-SCORE.md) | 冲突策略、方向预测阈值 |
| [DATA-QUALITY.md](./DATA-QUALITY.md) | 红档关闭操作、Web 色点 |
| [LONG-TERM-OUTLOOK.md](./LONG-TERM-OUTLOOK.md) | allocationStance 入仓位 |
| [ROADMAP-FINENG.md](./ROADMAP-FINENG.md) | **仓位 v2 规划**：波动缩放、日平滑、回撤刹车、纸面 MaxDD |

### 已落地 — 风险约束仓位 v2（2026-07-16）

```
target = base(score)
target = min(target, gate_cap | dual_cap | 一致上限)
target *= volScalar * ddScalar     # 近20日年化波动 / 近60日回撤
target = smooth(target, prev, maxΔ=10)  # 相对昨日单日最多 ±10 点
写入 overall.positionTargetPct    # 供次日平滑
```

| 项 | 说明 |
|----|------|
| 模块 | `position-recommend.ts`：`volToScalar` / `drawdownToScalar` / `smoothTargetPct` |
| 接入 | `analysis` 主路径 + Smart；`closes` 来自金价序列 |
| MD | 风险角标、波动%、回撤%、较昨日 |
| Web | `server.cjs` 仓位面板角标 + 风险摘要行 |

定投体验：**金价晃得厉害少拿一点；别一天建议大变。**

---

## 7. 免责

- 仓位百分比 = 相对计划黄金仓，**不是**总资产占比或融资建议。  
- 命中率依赖样本与 5 日标签，**不是**业绩承诺。  
- 门禁红档时请勿依据报告加减仓；优先修数据再 analysis。
