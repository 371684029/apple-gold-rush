# AGENTS.md

## Cursor Cloud specific instructions

### 提交署名（用户要求，永久）
本仓库 git 提交统一使用 **`wll <371684029@qq.com>`**。每个新会话开始时请先执行：

```
git config --local user.name "wll"
git config --local user.email "371684029@qq.com"
```

不要使用 `Cursor Agent` 等默认署名，提交信息中也不要夹带 `Co-authored-by` / Cursor 等尾注。

### What this is
GoldRush（黄金投资研究 Agent）核心是 **CLI 工具**。入口 `src/index.ts`（Commander.js），数据存于本地 SQLite（`better-sqlite3`，文件 `./data/goldrush.db`，首次运行自动创建，已被 `.gitignore` 忽略）。

生产机另有可选 **`server.cjs`**（HTTP 报告站，常监听 :80），与 CLI 共用 `docs/` 与 DB，**不是** CLI 运行所必需。

### Run / lint / build（命令见 `package.json` scripts）
- 开发模式（直接跑 TS，无需编译）：`npm run dev -- <command>`，例如 `npm run dev -- history`。
- 编译后运行：`npm run build` 然后 `node dist/index.js <command>`。
- Lint = 类型检查：`npm run lint`（即 `tsc --noEmit`）。
- 单元测试：`npm test`（`vitest run`）。测试位于 `test/` 目录（不在 `tsconfig` 的 `include` 内，故不会被 `build`/`lint` 编译进 `dist`），主要覆盖纯函数（时区、百分位、时效性、校准分桶）。
- 命令列表见 `README.md`（`price` / `analysis` / `fund` / `calibrate` / `snapshot` / `init-history` / `history`）。

### 非显而易见的运行前提（重要）
- **依赖外部 LLM 服务的命令**：`price`、`analysis`、`fund`、`snapshot`、`init-history` 都会调用 `DataCollectorAgent`，经 `src/agents/base.ts` 请求 opencode 服务器（`OPENCODE_SERVER`，默认 `http://localhost:8080`，Basic Auth 用 `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`，默认 `opencode`/`goldrush2026`；provider/model 见 `goldrush.config.json` 或 `src/types/config.ts` 的 `DEFAULT_CONFIG`，默认 `opencode-go` provider）。该服务器是**仓库外的自建/代理服务**，沙箱里默认不存在。未启动时这些命令会**优雅降级**（打印提示、退出码 0），**不会写入任何数据**。
- **`TAVILY_API_KEY`（可选）**：联网搜索用 Tavily（`@tavily/core`）。未配置时 `SearchRouter` 降级为空结果（不报错）。可写入 `.env`（见 `.env.example`）。
- **纯本地命令（无需任何外部服务）**：`history`、`calibrate`、`diff`、`digest`、`notify --test`（未配置 webhook 时仅打印跳过）；`notify --daily` 需配置 `GOLDRUSH_WEBHOOK_URL` 或 `goldrush.config.json` 的 `alerts.webhookUrl` 才会实际发送。`flow` 在已有 CFTC 数据时可纯本地算分；拉新数据需出站网络。
- **`init-history` / `analysis` Step 0**：优先 **Yahoo Finance GC=F** 日线补 `london_close`；Yahoo 超时/失败时回落 **LBMA** 下午定盘（`yahoo-gold-history.ts` → `fetchLbmaGoldHistory`）。**无需 Tavily**。当日现货采集仍走 Tavily+LLM，再经 **live anchors** 补齐缺失字段。
- **Validator spot-check**：伦敦/上海仅单源时，Validator 会额外 Tavily 搜索并从 snippet 启发式抽价；同时注入 Yahoo/gold-api 等 A 级锚定。
- 技术指标（MA/RSI/MACD 等）需积累约 20 个**有效**交易日（`london_close > 0`）后才可靠。

### 数据质量硬规则（2026-07 起，必读）
详见 `docs/DATA-QUALITY.md`。摘要：

1. **禁止把 0 当有效金价**：`isValidMarketNumber` / `isMissingPrice`（`schemas/market.ts`）；`saveSnapshot` 与 `GoldPricesRepo.upsert` 不写入、不覆盖有效列为 0。
2. **读库净化**：`mapRow` 将历史脏数据 `0` 映射为 `null`，避免 MA/RSI 被污染。
3. **forwardFill 跳过 ≤0**：`price-series.ts`；否则会出现「偏离 MA20 -100%」假信号。
4. **先锚定后搜索**：`collectMarketData` 先直连 gold-api/新浪，再 Tavily+LLM 补全；锚定失败且无金价则 fail-fast。
5. **置信度**：A 级单源 **72**；伦敦金字段权重 50%；锚定一致时 LLM 权重 0.2。
6. **门禁**（`data-quality-gate.ts`）：**勿用 conf&lt;55 硬拦**。红档=无金价 / 锚定偏差&gt;3% / conf&lt;35 → 关闭操作结论；黄档可出报告；绿档 conf≥70 且锚定贴合。
7. **双打分**（`dual-score.ts`）：LLM 分与量化分**始终并排**；`|Δ|&gt;15` 或弱一致性 → **操作弃权（维持定投）**，不抬某一侧权重；`calibrate` 分轨统计谁更准；量化因子 `event_heat` 默认 0，无效因子可在 `DEFAULT_WEIGHTS` 置 0。

### 出站网络现状（生产机实测，会变）
| 源 | 状态 | 用途 |
|----|------|------|
| cftc.gov | 通 | COT |
| gold-api.com / 新浪 hq | 通 | 现货金锚定 |
| prices.lbma.org.uk | 通 | 历史金价 |
| 东财 search-api | 通 | **GLD 吨数 / PBOC 储备** 新闻解析 |
| Yahoo query1 | 常超时 | 有回落，勿假设必通 |
| FRED | 常超时 | 10Y/TIPS/宽美元可能空 |
| SPDR CSV / Yahoo GLD 份额 | 常失败 | 已用东财持仓新闻替代 |

改数据源时：优先在 `src/data/live-anchors.ts` 加瀑布源，并保持「无数据 → null/中性，不编造」。

### 注意
- 源码脚手架最初缺失 `src/data/`（`data-collector.ts` import 的 `../data/search-router.js`）。若 `npm run build` 报 `Cannot find module '../data/search-router.js'`，说明该模块缺失会导致**整个构建失败**（`index.ts` 静态引入了所有命令）。本仓库已补回 `src/data/search-router.ts`。
- `price` / `analysis` 冒烟会调 LLM，可能跑 5–15 分钟；验收优先 `npm test`、`flow`、直连锚定探针，再跑完整 `analysis`。

---

## 双打分制（LLM + 量化）

`analysis` 命令运行两套独立评分系统并行对比：

### LLM 评分（主）
```
四维度(技术/基本/情绪面) LLM 均分 → 反驳修正 → 校准偏移 → finalScore
```
依赖 opencode 服务器，有随机性。

### 量化评分（参）
纯本地计算，零 LLM，100% 可复现。入口 `src/indicators/quant-score.ts`。

**因子体系（11 类，权重总和 = 1.0）：**

| 因子 | key | weight | 数据源 | 逻辑 |
|------|-----|--------|--------|------|
| 金价趋势 | `trend` | 12% | `gold_prices.london_close` | MA20 偏离百分比 → 信号分 |
| RSI 动量 | `rsi` | 10% | 同上 | RSI(14) 直接值 |
| MACD 动能 | `macd` | 10% | 同上 | histogram/price 归一化 |
| 布林带 | `bollinger` | 5% | 同上 | %B 反转（低轨→偏多） |
| 估值水位 | `valuation` | 8% | 同上 | 历史百分位反转 |
| 主力动向 | `flow` | 15% | SQLite `institutional_flows` | CFTC+GLD+央行综合分 |
| 美元指数 | `dxy` | 12% | `gold_prices.dollar_index` | DXY 偏离 MA20，反向 |
| 名义利率 | `us10y` | 8% | `gold_prices.us10y_yield` | 10Y 偏离 MA20，反向 |
| **实际利率** | `tips` | 10% | `gold_prices.tips_yield` | **黄金最重要单一驱动**，反向 |
| 波动率 | `volatility` | 5% | 从 closes 计算 ATR | 高波动→中性偏多避险 |
| 宏观阶段 | `regime` | 5% | `opts.macroRegime.tag` | recession→85, tightening→25 |
| 事件热度 | `event_heat` | 0% | Tavily（预留） | 关键词计数，默认关闭 |

**改变因子权重时**：修改 `DEFAULT_WEIGHTS` 对象（`quant-score.ts`），确保总和 = 1.0。`event_heat` 启用时需在 `orchestrator.ts` 传入 `eventScore`。

**数据流**：`orchestrator.ts` 从 `GoldPricesRepo.getRecent(120)` 一次查询提取 4 个序列（`closes/dxy/us10y/tips`），传入 `computeQuantScore()`。全链路无新增查询。

**因子函数签名必须不可变**：所有因子函数接受纯数据数组，返回 `QuantFactorDetail`，不访问 DB/网络/LLM。

### 展示与冲突
- **终端**：双分并排 + `formatQuantScoreConsole` 因子表 + `evaluateDualScore` 策略行  
- **Markdown**：`## ⚖️ 双打分机制` + 因子表 + 弃权说明（`report-md.ts`）  
- **Web**：`server.cjs` 双分横幅 / 冲突时「维持定投」  
- **校准**：`calibrate` LLM 分桶 + 量化分桶 + 方向命中 + 冲突日统计  
- 完整说明：**`docs/DUAL-SCORE.md`**

### DB schema
```sql
analysis_reports.quant_score REAL   -- 量化评分（可为 NULL；新 analysis 写入）
-- report_json 内 overall.quantFactors 为因子明细（可选）
```
迁移是幂等的（`ALTER TABLE ADD COLUMN`，列已存在则忽略）。

### 数据质量
- **`saveSnapshot` 过滤**：`source: 'N/A'`、值为 0 的字段不入库（`data-collector.ts` + `GoldPricesRepo.upsert` sanitize）。
- **`scenario_features` 迁移**：`cftc_percentile`、`etf_flow_5d`、`flow_score` 三列有幂等迁移（`db/index.ts`），旧 DB 自动补齐。
- **`institutional_flows`**：`flow --init` 回填 CFTC；**GLD 吨数 / PBOC 储备** 优先 **东财搜索新闻解析**（`etf-grabber` / `pboc-grabber`）；失败不编造。
- **flow 因子 15%**：CFTC+GLD+央行综合；单维缺失时该维中性，不编造持仓。
