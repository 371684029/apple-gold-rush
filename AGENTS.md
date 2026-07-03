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
- **`init-history`**：需 `TAVILY_API_KEY`，会尝试回填过去 N 天缺失的 `london_close` 并采集当日；无法联网时请改用每日 `snapshot` 积累。
- 技术指标（MA/RSI/MACD 等）需积累约 20 天快照后才生效。

### 注意
- 源码脚手架最初缺失 `src/data/`（`data-collector.ts` import 的 `../data/search-router.js`）。若 `npm run build` 报 `Cannot find module '../data/search-router.js'`，说明该模块缺失会导致**整个构建失败**（`index.ts` 静态引入了所有命令）。本仓库已补回 `src/data/search-router.ts`。
