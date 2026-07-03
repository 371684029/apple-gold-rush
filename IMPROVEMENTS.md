# GoldRush 改进存档

> 本文档归纳一次代码体检后实施的改进。改进原则严格对齐项目立意（见 `CORRECTNESS-SPEC.md`）：
> **「成本不是问题，正确率和风险暴露率才是关键。」** 因此本轮聚焦三类：
> ① 修复影响「正确率」的算法/时区 bug；② 强化「严禁捏造数据」的反幻觉防线；
> ③ 补齐健壮性与可测试性（项目此前零测试）。未改动整体架构，未引入新外部服务。

---

## 一、项目立意回顾（为何这样改）

GoldRush 是面向支付宝黄金定投者的 CLI 研究 Agent：一条命令完成「采集 → 验证 → 四维度分析 → 强制反驳 → 情景 + 双轨策略」，并通过**回测校准闭环**让评分具备统计意义。文档反复强调的核心价值不是「说得像」，而是：

- **数值本地计算、不交给 LLM**（防幻觉）——故技术指标/时区/百分位的算法必须正确；
- **严禁捏造数据**、信息可靠性五道防线——故无数据来源时不应让 LLM 凭空"提取"；
- **评分可回测**——故校准分桶必须覆盖全部评分（含满分）。

本轮改进即针对上述原则中「实现与立意有偏差」之处。

---

## 二、改进清单

### A. 正确性 / 算法 bug

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| A1 | `src/utils/time.ts` `todayDate()` | 手动 `+8h + getTimezoneOffset()` 再 `toISOString()`，在 **UTC+8 机器**上偏移被抵消，返回 UTC 日期而非上海日历日，导致「今日」判断与入库 key 错位 | 改用 `Intl.DateTimeFormat(timeZone:'Asia/Shanghai')` 取日历分量，**不受运行机器时区影响**；并支持注入 `now` 便于测试 |
| A2 | `src/utils/time.ts` `getTradingTime()` | 夜盘注释为「20:00~次日02:30」，但条件 `hour < 2` 把 **02:00~02:30 误判为盘前** | 条件补齐为 `hour < 2 \|\| (hour === 2 && minute <= 30)`；同样改用上海时区分量 |
| A3 | `src/indicators/percentile.ts` `rollingPercentile()` | 窗口 `slice(i-window+1, i)` **不含当前值**，百分位语义错误（相对"过去 window-1 点"而非标准"含当前的 window"） | 改为 `slice(i-window+1, i+1)` |
| A4 | `src/db/calibration.ts` / `src/db/reports.ts` | 评分区间为左闭右开 `[min,max)`，**满分 100 落不进任何区间** → `getCalibrationContext(100)` 返回 `null`，满分报告无校准上下文、回测被丢弃 | 抽出纯函数 `src/utils/score-buckets.ts`（`scoreBucketRange`，最高区间右端取闭），`computeCalibration` 与 `getByScoreRange` 统一令 max=100 时取闭区间 |

### B. 反幻觉 / 信息可靠性（对齐「严禁捏造数据」）

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| B1 | `src/agents/data-collector.ts` | 搜索结果全空（无 `TAVILY_API_KEY` 或搜索失败）时**仍调用 LLM 做"结构化提取"**，极易凭空捏造金价 | 采集前增加反捏造防线：若所有搜索结果为空则 **fail-fast** 抛出明确错误，绝不让 LLM 无据生成 |

### C. 健壮性 / 空值防御（LLM 可能返回 null 字段）

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| C1 | `src/agents/rebuttal.ts` | 直接访问 `marketData.london.price.value` 等（采集 schema 允许 null）→ 运行期 `TypeError` 中断流水线；另有「厂市场数据」笔误 | 全部改为可选链 + `?? 'N/A'`，新增 `fmtPct` 统一格式化；修正笔误 |
| C2 | `src/agents/orchestrator.ts` | 同上：prompt 与 `saveReport` 直接访问可空市场字段、`rebuttal.bearPoints.map` 等 | 可选链 + `?? 'N/A'` / `?? []` 防御 |
| C3 | `src/commands/analysis.ts` `printReport()` | `rebuttal.bearPoints.slice` / `tailRisks.length` 在字段缺失时崩溃 | `(... ?? []).slice` / 先取 `tailRisks ?? []` |
| C4 | `src/utils/source-rank.ts` `checkFreshness()` | 非法时间戳 → `NaN > threshold` 为 false → **误判为"新鲜"** | 增加 `Number.isNaN` 守卫，非法时间戳判为不新鲜并给出警告 |

### D. CLI 一致性 / 功能补齐

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| D1 | `src/index.ts` | `history --type` 无白名单校验，非法值静默走错误分支 | 校验 `prices/reports`，非法值报错退出 |
| D2 | `src/commands/calibrate.ts` | `--detail` 选项已注册但**完全未使用**（死选项） | 实现 `--detail`：按评分区间展开「预测方向 / 实际上涨数 / 校准误差 / 系统偏差」明细 |

---

## 三、测试（项目此前零测试）

引入 **vitest**（`npm test` → `vitest run`），针对上述纯函数 bug 编写单元测试，共 **20 个用例全部通过**：

| 测试文件 | 覆盖 |
|----------|------|
| `test/time.test.ts` | `todayDate` 上海时区跨日；`getTradingTime` 夜盘 02:00~02:30 边界、日盘、周末休市 |
| `test/percentile.test.ts` | `rollingPercentile` 窗口含当前值；`percentile` 边界 |
| `test/source-rank.test.ts` | `checkFreshness` 非法/空/新鲜/过期；`gradeSource` 分级 |
| `test/score-buckets.test.ts` | `scoreBucketRange` 满分 100 归入 90-100、边界与越界 |

> 说明：测试置于 `test/` 目录，不在 `tsconfig` 的 `include`（`src/**/*`）内，故不会被 `build`/`lint` 编译进 `dist`。

---

## 四、验证方式

- `npm run lint`（`tsc --noEmit`）通过；
- `npm run build`（`tsc`）通过；
- `npm test`（vitest）20/20 通过；
- 端到端：用应用自身仓储向本地 SQLite 注入 40 天金价 + 10 条报告（含满分 100），`node dist/index.js calibrate --days 90 --detail`：
  - `90-100` 区间样本数为 **2**（含 92 与 100，证明满分不再被丢弃）；
  - `--detail` 明细正常输出（证明死选项已生效）；
- `node dist/index.js price`（无 `TAVILY_API_KEY`）现以**明确的反捏造提示**中止，而非含糊的 `fetch failed`。

---

## 五、未在本轮处理（建议后续）

以下为体检中发现、但属于**架构级 / 需外部服务或更大改动**的差距，留作后续（与 `CORRECTNESS-SPEC.md` 路线图一致）：

- **文档 vs 实现的搜索层**：文档为 Exa + opencode 双引擎，实现为 Tavily 单引擎（`exa-js` 依赖未使用）；
- **Validator 未做多源交叉验证 / 未调用 LLM**（`VALIDATION_PROMPT` 闲置），与"3 源验证"承诺不符；
- **`init-history` 名不副实**：仅采当日一条，未真正拉取 60 天历史；
- **技术指标用日线 close 冒充周线**；`history.map(...).filter()` 压缩缺失日导致指标序列不等间隔（需 forward-fill / 交易日对齐）；
- **历史模式匹配**（`scenario_features` + 余弦相似度）与 `search_cache`、`fund_nav` 写入、`database.path` 生效等均未落地；
- **评分一致性**：编排 LLM 自出的 `overall.score` 未必等于反驳修正分 `adjustedScore`。

---

## 六、第二轮（参考 sibling 项目 hongliRush）

> `hongliRush`（同账号兄弟项目，定位"大A红利金融投资日报"）当前仅有占位 README，核心立意是**"投资日报 + 可读报告"**。据此为 GoldRush 优化「功能 + 样式」并补充文档。

### 功能：Markdown 投资日报导出
| 文件 | 说明 |
|------|------|
| `src/utils/report-md.ts`（新增） | 纯函数 `formatReportMarkdown(report, horizon)`：把完整分析报告渲染为人类可读的 Markdown 日报（综合研判 / 情景表 / 四维度表 / 强制反驳 / 双轨策略 / 尾部风险表 / 免责声明），对 LLM 缺失字段降级为 `N/A`，不抛错 |
| `src/commands/analysis.ts`、`src/index.ts`、`src/types/config.ts` | 新增 `analysis --md`：将日报写入 `goldrush-日报-YYYY-MM-DD.md`（此前 `--save` 仅导出原始 JSON） |

### 样式：表格化输出
- `src/commands/history.ts`：`history`（prices/reports）改用项目已内置但此前未使用的 **`cli-table3`** 渲染，替代手写 `padStart`，对齐与 CJK 宽度更稳。

### 测试
- `test/report-md.test.ts`：用合成报告验证日报含全部小节、`horizon=short` 不输出中长期、字段缺失降级 `N/A`。总用例 **20 → 23**。

### 文档
- `README.md`：运行示例与命令表补充 `analysis --md`；`--save` 标注为 JSON。

---

## 七、第三轮（优化项落地）

针对体检清单中的 P0/P1 项，在 `main` 分支直接修复：

| 优先级 | 项 | 修复 |
|--------|-----|------|
| P0 | 反驳评分方向错误（强看空反驳反而抬高偏多分） | 新增 `src/utils/rebuttal-score.ts`：向 `(100 - bearScore)` 靠拢，替代 `(bearScore - originalScore)` |
| P0 | `goldrush.config.json` 与代码结构不匹配 | `loadConfig` 深合并 + 识别 `llm.models` 别名；`goldrush.config.json` 改为扁平结构 |
| P0 | 尾部风险指数虚高（98%+） | 新增 `src/utils/tail-risk.ts`：互斥修正 + `maxTailRiskIndex` 上限 |
| P1 | 单源仍标 `verified` | `crossValidate` 单源改为 `single_source`，置信度 35–55 |
| P1 | 技术指标 `filter` 压缩缺失日 | `forwardFillCloses` 前向填充收盘价 |
| P1 | `analysis` 失败 exit 0 | 采集失败返回 1，`index.ts` 非零退出 |
| P1 | `database.path` 未生效 | `getDb()` 读取 `getConfig().database.path` |
| P1 | `server.cjs` 安全 | 默认 `127.0.0.1:3000`、规范化路径防穿越、DOMPurify 净化 Markdown |

### 测试
- `test/rebuttal-score.test.ts`、`test/tail-risk.test.ts`、`test/config.test.ts`；`source-rank` 补单源用例。总用例 **23 → 35**。

### 仍未处理（P2 / 架构级）
- Zod 校验替代手写 JSON 修复；评分乘数在线校准；推理门控；RAG 向量库等（见第五节）。

---

## 八、第四轮（P1 数据层 + 正确性，移除 Exa 双引擎）

| 项 | 落地 |
|----|------|
| `search_cache` 接入 | `SearchRouter` 读写在 `SearchCacheRepo`，TTL 用 `search.cacheMinutes` |
| `fund_nav` 写入 | 采集/ fund 命令写入 `FundNavRepo`；`FundAgent` 输出 `funds` 对比表 |
| `init-history` 回填 | `backfillHistory(days)` + `--days`；缺失日 LLM 提取 london_close |
| 多源交叉验证 | 采集增加备用搜索 + `altPrices`；`validationSourcesFromPrices` |
| 周线指标 | `weekly-series.ts` forward-fill 后 ISO 周聚合 |
| 依赖清理 | 移除未使用的 `exa-js`；README/AGENTS 改为 Tavily 单引擎表述 |
| 测试 | `history-backfill` / `weekly-series` / 多源验证；**61** 用例 |

