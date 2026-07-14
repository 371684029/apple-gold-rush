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
GoldRush（黄金投资研究 Agent）是一个**纯本地 CLI 工具**（无 web server、无监听端口）。入口 `src/index.ts`（Commander.js），数据存于本地 SQLite（`better-sqlite3`，文件 `./data/goldrush.db`，首次运行自动创建，已被 `.gitignore` 忽略）。

### Run / lint / build（命令见 `package.json` scripts）
- 开发模式（直接跑 TS，无需编译）：`npm run dev -- <command>`，例如 `npm run dev -- history`。
- 编译后运行：`npm run build` 然后 `node dist/index.js <command>`。
- Lint = 类型检查：`npm run lint`（即 `tsc --noEmit`）。
- 单元测试：`npm test`（`vitest run`）。测试位于 `test/` 目录（不在 `tsconfig` 的 `include` 内，故不会被 `build`/`lint` 编译进 `dist`），主要覆盖纯函数（时区、百分位、时效性、校准分桶）。
- 命令列表见 `README.md`（`price` / `analysis` / `fund` / `calibrate` / `snapshot` / `init-history` / `history`）。

### 非显而易见的运行前提（重要）
- **依赖外部 LLM 服务的命令**：`price`、`analysis`、`fund`、`snapshot`、`init-history` 都会调用 `DataCollectorAgent`，经 `src/agents/base.ts` 请求 opencode 服务器（`OPENCODE_SERVER`，默认 `http://localhost:8080`，Basic Auth 用 `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`，默认 `opencode`/`goldrush2026`；provider/model 见 `goldrush.config.json` 或 `src/types/config.ts` 的 `DEFAULT_CONFIG`，默认 `opencode-go` provider）。该服务器是**仓库外的自建/代理服务**，沙箱里默认不存在。未启动时这些命令会**优雅降级**（打印提示、退出码 0），**不会写入任何数据**。
- **`TAVILY_API_KEY`（可选）**：联网搜索用 Tavily（`@tavily/core`）。未配置时 `SearchRouter` 降级为空结果（不报错）。可写入 `.env`（见 `.env.example`）。
- **纯本地命令（无需任何外部服务）**：`history`、`calibrate`、`diff`、`digest`、`notify --test`（未配置 webhook 时仅打印跳过）；`notify --daily` 需配置 `GOLDRUSH_WEBHOOK_URL` 或 `goldrush.config.json` 的 `alerts.webhookUrl` 才会实际发送。
- **`init-history` / `analysis` Step 0**：自动从 **Yahoo Finance GC=F** 拉取约 60 日历日窗口内的交易日 `london_close` 写入 SQLite（**无需 Tavily**），满足 MA/RSI/MACD（≥20 个交易日）。当日实时价仍依赖 Tavily+LLM 的 `collectMarketData`。
- **Validator spot-check**：伦敦/上海仅单源时，Validator 会额外 Tavily 搜索并从 snippet 启发式抽价做多源交叉验证（无需额外 LLM）。
- 技术指标（MA/RSI/MACD 等）需积累约 20 天快照后才生效。

### 注意
- 源码脚手架最初缺失 `src/data/`（`data-collector.ts` import 的 `../data/search-router.js`）。若 `npm run build` 报 `Cannot find module '../data/search-router.js'`，说明该模块缺失会导致**整个构建失败**（`index.ts` 静态引入了所有命令）。本仓库已补回 `src/data/search-router.ts`。

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
| 主力动向 | `flow` | 15% | MySQL→DB 直读 | CFTC+ETF+央行综合分 |
| 美元指数 | `dxy` | 12% | `gold_prices.dollar_index` | DXY 偏离 MA20，反向 |
| 名义利率 | `us10y` | 8% | `gold_prices.us10y_yield` | 10Y 偏离 MA20，反向 |
| **实际利率** | `tips` | 10% | `gold_prices.tips_yield` | **黄金最重要单一驱动**，反向 |
| 波动率 | `volatility` | 5% | 从 closes 计算 ATR | 高波动→中性偏多避险 |
| 宏观阶段 | `regime` | 5% | `opts.macroRegime.tag` | recession→85, tightening→25 |
| 事件热度 | `event_heat` | 0% | Tavily（预留） | 关键词计数，默认关闭 |

**改变因子权重时**：修改 `DEFAULT_WEIGHTS` 对象（`quant-score.ts`），确保总和 = 1.0。`event_heat` 启用时需在 `orchestrator.ts` 传入 `eventScore`。

**数据流**：`orchestrator.ts` 从 `GoldPricesRepo.getRecent(120)` 一次查询提取 4 个序列（`closes/dxy/us10y/tips`），传入 `computeQuantScore()`。全链路无新增查询。

**因子函数签名必须不可变**：所有因子函数接受纯数据数组，返回 `QuantFactorDetail`，不访问 DB/网络/LLM。

### 展示位置
- **终端**：`formatQuantScoreConsole()` 输出因子明细表
- **Markdown**：`report-md.ts` 在综合研判段显示对比行
- **Web**：`server.cjs` 的 `extractQuantScore()` 从 MD 解析 → 仪表盘/快速阅读卡展示
- **校准**：`calibrate.ts` 同时校准 LLM 分和量化分，输出对比表

### DB schema
```sql
analysis_reports.quant_score REAL   -- 量化评分（可为 NULL）
```
迁移是幂等的（`ALTER TABLE ADD COLUMN`，列已存在则忽略）。

### 数据质量
- **`saveSnapshot` 过滤**：`source: 'N/A'` 的数据不会写入 DB（`data-collector.ts`），避免 dxy/10y/tips 误存 0.0。Tavily 未抓到的字段正确存 NULL。
- **`scenario_features` 迁移**：`cftc_percentile`、`etf_flow_5d`、`flow_score` 三列有幂等迁移（`db/index.ts`），旧 DB 自动补齐。
- **`institutional_flows` 需初始化**：首次运行 `goldrush flow --init` 才填充 CFTC+GLD 数据，否则 flow 因子（15% 权重）返回 50 中性分。需能访问 cftc.gov 和 spdrgoldshares.com。
