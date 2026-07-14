# GoldRush — 黄金投资研究 Agent

一个 CLI 工具，一条命令自动采集金价数据、四维度分析、强制反驳、回测校准、主力动向监测，输出**短期+中长期双视角**策略报告。

面向通过**支付宝基金**做黄金中长期配置的个人投资者，同时兼顾短线参考。

---

## 快速开始

### 前置条件

- Node.js >= 20
- opencode CLI 已安装且可用（`opencode run` 能正常调用）
- （可选）Tavily API Key — 用于联网金融数据搜索

### 安装

```bash
git clone <repo-url> && cd goldRush
npm install
npm run build
```

### 配置（可选）

```bash
# Tavily API（联网金融数据搜索，不配也能跑，会降级为空结果）
export TAVILY_API_KEY=your_tavily_api_key_here

# 或者写到 .env 文件
cp .env.example .env
# 编辑 .env 填入你的 TAVILY_API_KEY
```

### 运行

```bash
# 默认仪表盘 — 一眼看懂（金价 + 研判 + 主力 + 建议）
node dist/index.js

# 实时金价
node dist/index.js price

# 综合分析报告（默认双视角 + 信号一致性 + 人话建议）
node dist/index.js analysis

# 导出 Markdown 投资日报
node dist/index.js analysis --md

# 主力动向监测（CFTC 持仓 + ETF 资金流 + 央行购金 + 背离检测）
node dist/index.js flow

# 导出主力监测日报
node dist/index.js flow --md

# 基金对比分析
node dist/index.js fund

# 首次回填历史（无需 Tavily，Yahoo 日线）
node dist/index.js init-history --days 60

# 首次回填主力数据
node dist/index.js flow --init
```

建议设置 alias 方便使用：

```bash
alias goldrush="node /path/to/goldRush/dist/index.js"
goldrush                    # 默认仪表盘
goldrush price
goldrush analysis
goldrush flow
```

---

## 命令一览

| 命令 | 说明 |
|------|------|
| `goldrush` | **默认仪表盘**（金价 + 最新研判 + 主力动向 + 操作建议） |
| `goldrush price` | 实时金价速查，自动存 SQLite |
| `goldrush analysis` | 综合分析报告（四维度+反驳+情景+双轨策略+信号一致性+人话建议） |
| `goldrush analysis -H short` | 仅短期视角（日线/入场止损） |
| `goldrush analysis -H mid` | 仅中长期视角（周线/定投加减仓） |
| `goldrush analysis --json` | JSON 格式输出 |
| `goldrush analysis --md` | 保存报告为 Markdown 到 docs/ 目录 |
| `goldrush flow` | **主力动向监测**（CFTC + GLD ETF + 央行购金 + 背离检测） |
| `goldrush flow --init` | 首次回填 CFTC + GLD 全部历史数据 |
| `goldrush flow --json` | JSON 格式输出 |
| `goldrush flow --md` | 主力日报写入 docs/ |
| `goldrush fund` | 黄金基金对比（费率/溢价/定投信号） |
| `goldrush calibrate` | 回测校准（历史准确率统计） |
| `goldrush calibrate --days 90` | 回顾 90 天 |
| `goldrush snapshot` | 手动保存当日数据快照 |
| `goldrush init-history` | Yahoo GC=F 回填 60 天 |
| `goldrush history` | 查看历史金价/报告/基金 |
| `goldrush diff <dateA> <dateB>` | 对比两日报告变化 |
| `goldrush digest --days 7` | 周期摘要（均分、跳变） |
| `goldrush notify --test` | Webhook 连通性测试 |
| `goldrush outlook` | 1/3/5 年长期方向预期 |

---

## 架构

```
用户 CLI 命令
    │
    ▼
Commander.js (命令路由)
    │
    ▼
Orchestrator (编排层)
    │
    ├──→ 数据采集层
    │     ├── Tavily 搜索 (LLM 提取金价/美元/美债)
    │     ├── Yahoo Finance 直连 (GC=F/DXY 实时价, A级锚定源)
    │     ├── CFTC.gov ZIP 解析 (COT 持仓报告, 周度)
    │     └── SPDR CSV 解析 (GLD ETF 持仓, 日度)
    │
    ├──→ 数据验证层
    │     ├── 多源交叉验证 (Yahoo锚定 + Tavily多源)
    │     ├── 来源分级 (A/B/C)
    │     └── Yahoo A级源注入 → 置信度 46%→65%+
    │
    ├──→ 主力动向层 (纯本地计算, 不依赖 LLM)
    │     ├── CFTC 持仓评分 (非商业净多百分位 + 趋势)
    │     ├── GLD ETF 资金流评分 (5日/20日持仓变化)
    │     ├── 央行购金信号 (PBOC 月度储备)
    │     ├── 背离检测 (价-仓-量 背离)
    │     └── 综合主力评分
    │
    ├──→ 四维度分析 (LLM)
    │     ├── 技术面 (本地 MA/RSI/MACD + LLM 解读)
    │     ├── 基本面 (美元/美债/美联储)
    │     ├── 情绪面 (注入本地主力数据替代 LLM 猜测)
    │     └── 基金面 (费率/溢价/估值水位)
    │
    ├──→ 强制反驳 Agent (独立 session)
    │
    └──→ 综合编排 Agent
          注入校准上下文 + 三情景分析 + 尾部风险
          输出双轨策略 + 信号一致性 + 人话建议
```

---

## 核心设计

### 数据源

| 数据源 | 方式 | 频率 | 用途 |
|--------|------|------|------|
| Tavily 搜索 | LLM 提取 | 按需 | 金价/美元/美债/新闻 |
| **Yahoo Finance** | **HTTP 直连 (零 LLM)** | 实时 | GC=F 金价锚定源 / DXY / 10Y |
| **CFTC.gov** | **ZIP 下载 + 本地解析** | 周度 | COT 持仓报告 (黄金 088691) |
| **SPDR** | **CSV 下载 + 本地解析** | 日度 | GLD ETF 持仓 (吨/变化/AUM) |
| PBOC 官网 | 新闻搜索 | 月度 | 中国央行黄金储备 |

### 主力动向监测 (`goldrush flow`)

纯本地计算，不依赖 LLM。追踪三大维度：

| 维度 | 数据 | 评分逻辑 |
|------|------|----------|
| CFTC 投机持仓 | 非商业净多头 | 历史百分位 (40%) + 趋势 (30%) + 极端信号 (20%) |
| GLD ETF 资金流 | 日度持仓变化 | 5日趋势 (40%) + 20日趋势 (30%) + 持仓水位 (20%) |
| 央行购金 | PBOC 月度储备 | 连续增持月数 (50%) + 月度变化 (30%) |

综合评分 = 0.40×CFTC + 0.30×ETF + 0.15×央行 + 0.15×其他。

### 信息可靠性

1. **Yahoo A 级锚定源** — 直连数据作为交叉验证基准，不依赖 LLM 提取
2. **来源分级** — A级(交易所/央行) > B级(财经媒体) > C级(自媒体)
3. **3源交叉验证** — 同一数据至少3个独立来源
4. **中英文双搜** — 避免单一信息茧房
5. **反向核查** — 重大新闻必须搜反对观点

### 强制反驳机制

正常分析天然偏乐观。强制反驳 Agent 独立运行，专门找看空论据：

```
四维度分析 → 初步评分 70 分
    ↓
反驳 Agent (看不到综合评分，避免锚定)
    ↓
看空力度 42/100，反驳强度 moderate
    ↓
评分修正: 70 → 64 (下调 6 分)
    ↓
最终输出: 64 分 + 反驳摘要 + 尾部风险 + 信号一致性 + 人话建议
```

### 信号一致性检查

四维度方向一致性检测：

| 一致性 | 标记 | 含义 |
|--------|------|------|
| 4/4 一致 | ✅ 强一致 | 全部维度同方向 |
| 3/4 一致 | ⚠️ 中等 | 1个维度唱反调 |
| ≤2/4 一致 | 🔴 弱 | 方向分歧，谨慎参考 |

### 人话分数映射

| 评分 | 建议 |
|------|------|
| 0-30 | 🔴 暂停定投，等待评分回升至 45 以上 |
| 30-45 | 🟠 放慢定投节奏，不加仓 |
| 45-55 | 🟡 维持基础定投，按日历执行 |
| 55-75 | 🟢 维持定投；急跌可小幅加码，高位不追 |
| 75-100 | 🔵 可适度加码，但高位不追、设好止盈 |

### 双视角输出

| 维度 | 短期 | 中长期 |
|------|------|--------|
| 时间框架 | 日线/小时线 | 周线/月线 |
| 持仓周期 | 数天~2周 | 1~6个月 |
| 推荐品种 | 518880 场内ETF | 000216/002610 联接基金 |
| 策略核心 | 入场点位、止盈止损 | 定投节奏、加减仓 |
| 风控方式 | 固定止损 3-5% | 估值止盈、仓位管理 |

### 双打分制（LLM + 量化并行）

`analysis` 命令同时运行两套独立评分系统：

- **LLM 评分**：四维度分析 → 反驳修正 → 校准偏移（依赖 opencode 服务器）
- **量化评分**：纯本地计算，11 类因子加权求和，零 LLM，100% 可复现

终端同时显示两套评分对比，`calibrate` 命令分开展示各自的准确率：

```
综合研判: 📈 67/100
████████████████░░░░
🔢 量化评分: ████████████░░░░░░ 63/100
   量化=63 📈 | LLM=67 | 偏差=LLM偏高 +4
```

量化因子权重可在 `src/indicators/quant-score.ts` 的 `DEFAULT_WEIGHTS` 中调整。

### 回测校准闭环

每次分析自动存档到 SQLite，`goldrush calibrate` 对比历史研判 vs 实际走势：

```
评分区间  样本  实际涨概率  平均涨幅  偏差
60-70     12    58%       +0.3%    偏乐观8%
70-80     18    67%       +0.8%    校准良好
80-90      8    75%       +1.2%    偏保守
90-100     2    50%      -0.1%    严重偏乐观！
```

校准数据自动注入综合编排 prompt，让评分有统计意义。

---

## Web 报告展示

启动内置 HTTP 服务即可在浏览器查看所有报告：

```bash
node server.cjs
# → http://localhost 或服务器 IP: http://106.14.92.235
```

**Web 特性**：
- 🏠 首页：最新研判 + 历史报告列表 + 搜索/排序
- 📊 **30秒速读卡片**：评分 + 操作建议 + 维度标签，一眼看懂
- 📈 **预测仪表盘**：大号评分 + 校准置信 + 三情景概率
- 📁 **智能折叠**：默认只展开策略+情景，其余分析折叠
- 🏦 **主力仪表盘**：CFTC/ETF/央行 评分条 + 背离警告

### 每日定时分析

已在服务器设置每日 11:30 自动执行分析并生成 Markdown 报告（cron）：

```bash
crontab -l
# 30 11 * * * /root/git/goldRush/scripts/daily-analysis.sh
```

日志文件在 `logs/daily-YYYY-MM-DD.log`，报告自动保存到 `docs/` 目录，同步产出分析日报 + 主力监测日报。

---

## 本地数据存储

SQLite 数据库自动创建在 `data/goldrush.db`：

| 表 | 用途 |
|----|------|
| `gold_prices` | 每日金价快照（伦敦金/上海金/ETF/美元/美债） |
| `fund_nav` | 基金净值快照（000216/002610 等） |
| `institutional_flows` | **主力动向数据**（CFTC持仓/GLD持仓/PBOC储备） |
| `analysis_reports` | 分析报告存档（含完整 JSON） |
| `scenario_features` | 市场特征向量（含主力维度，用于历史模式匹配） |
| `search_cache` | 搜索缓存（5分钟内免重复请求） |

每次运行 `price`、`analysis` 或 `flow` 自动存数据，无需手动操作。

---

## 技术指标

本地计算，100% 客观，不依赖 LLM：

| 指标 | 实现 | 用途 |
|------|------|------|
| MA5/MA20/MA60 | `src/indicators/ma.ts` | 均线趋势、金叉死叉 |
| RSI(14) | `src/indicators/rsi.ts` | 超买超卖信号 |
| MACD | `src/indicators/macd.ts` | 动量方向、金叉死叉 |
| 布林带 | `src/indicators/bollinger.ts` | 波动区间、%B |
| 历史百分位 | `src/indicators/percentile.ts` | 估值水位判断 |
| **主力信号** | `src/indicators/flow-signal.ts` | CFTC/ETF/央行评分 + 背离检测 |

数据积累 20 天后技术指标自动生效，注入技术面 Agent prompt。

---

## 项目结构

```
goldRush/
├── src/
│   ├── index.ts              # CLI 入口 (Commander.js)
│   ├── commands/
│   │   ├── dashboard.ts      # [新] 默认仪表盘
│   │   ├── price.ts          # 实时金价
│   │   ├── analysis.ts       # 综合分析报告 (含主力+一致性+人话)
│   │   ├── flow.ts           # [新] 主力动向监测
│   │   ├── fund.ts           # 基金对比
│   │   ├── calibrate.ts      # 回测校准
│   │   ├── snapshot.ts       # 数据快照
│   │   └── history.ts        # 历史数据
│   ├── agents/
│   │   ├── base.ts           # Agent 基类 (opencode CLI)
│   │   ├── data-collector.ts # 数据采集 + Tavily 搜索
│   │   ├── validator.ts      # 信息验证 (含 Yahoo 锚定源注入)
│   │   ├── analysis-agents.ts# 四维度 Agent (情绪面注入主力数据)
│   │   ├── rebuttal.ts       # 强制反驳 Agent
│   │   └── orchestrator.ts   # 综合编排 Agent
│   ├── data/
│   │   ├── yahoo-live.ts     # [新] Yahoo 实时价格 (GC=F/DXY/10Y)
│   │   ├── yahoo-gold-history.ts # Yahoo 历史金价
│   │   ├── cftc-grabber.ts   # [新] CFTC COT 报告采集
│   │   ├── etf-grabber.ts    # [新] GLD ETF 持仓采集
│   │   ├── search-router.ts  # Tavily 搜索封装及路由
│   │   └── tavily-client.ts  # Tavily API 客户端
│   ├── db/
│   │   ├── index.ts          # SQLite 初始化 (含 institutional_flows)
│   │   ├── gold-prices.ts    # 金价 CRUD
│   │   ├── institutional-flows.ts # [新] 主力数据 CRUD
│   │   ├── fund-nav.ts       # 基金净值 CRUD
│   │   ├── reports.ts        # 报告存档 CRUD
│   │   ├── scenario-features.ts # 特征向量 CRUD (含主力维度)
│   │   ├── search-cache.ts   # 搜索缓存
│   │   └── calibration.ts    # 校准回测逻辑
│   ├── indicators/
│   │   ├── ma.ts / rsi.ts / macd.ts / bollinger.ts / percentile.ts
│   │   └── flow-signal.ts    # [新] 主力信号计算
│   ├── types/
│   │   ├── institutional.ts  # [新] 主力数据类型
│   │   └── ...
│   └── utils/
│       ├── ensure-flows.ts   # [新] 主力数据自动补齐
│       ├── plain-advice.ts   # [新] 人话建议 + 信号一致性
│       └── ...
├── web/
│   └── article-collapse.cjs  # Web 智能折叠 (只展开策略+情景)
├── server.cjs                # Web 服务 (端口80, 含新仪表盘)
├── data/goldrush.db          # SQLite (自动创建)
├── docs/                     # 报告存档
│   ├── FLOW-PLAN.md          # 主力监测设计规划
│   └── OPTIMIZATION.md       # 优化路线图 (五维度)
├── scripts/daily-analysis.sh # 每日定时分析 (含 flow --md)
└── package.json
```

---

## 技术栈

| 组件 | 选型 | 原因 |
|------|------|------|
| 语言 | TypeScript | 类型安全 |
| CLI | Commander.js | 成熟稳定 |
| LLM | opencode CLI | Go 套餐 $10/月封顶 |
| 搜索(联网) | Tavily | 金融分类搜索、内容提取 |
| 实时数据 | **Yahoo Finance API** | 免费、零 LLM、A 级锚定源 |
| 持仓数据 | **CFTC.gov + SPDR** | 官方数据、本地解析 |
| 数据库 | SQLite (better-sqlite3) | 零配置、本地、够用 |
| 终端输出 | chalk + cli-table3 | 表格+颜色 |
| 报告展示 | 内置 HTTP 服务 (server.cjs) | 端口80 仪表盘+折叠 |

---

## 开发

```bash
# 开发模式（直接运行 TS）
npm run dev -- price

# 编译
npm run build

# 类型检查
npm run lint

# 测试
npm test
```

---

## 文档

| 文档 | 内容 |
|------|------|
| [FLOW-PLAN.md](./docs/FLOW-PLAN.md) | 主力动向监测设计规划 |
| [OPTIMIZATION.md](./docs/OPTIMIZATION.md) | **优化路线图**（真实性、覆盖度、实时性、可靠性、交互） |
| [PLAN.md](./PLAN.md) | 完整项目规划 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构决策记录 |
| [CORRECTNESS-SPEC.md](./CORRECTNESS-SPEC.md) | 正确率改进规范 |
| [METHODOLOGY-DEEP-DIVE.md](./METHODOLOGY-DEEP-DIVE.md) | 金融 AI 方法论深度分析 |

---

## 注意事项

- 本工具仅供投资研究参考，**不构成投资建议**
- LLM 分析存在固有局限，请结合自身判断做出决策
- 数据依赖搜索结果及外部 API，可能存在延迟或偏差
- 建议积累 20 天以上数据后再使用 `calibrate` 命令
- Tavily API 免费额度 1000 次/月
- 主力数据（CFTC/GLD）首次使用需运行 `goldrush flow --init` 回填历史
