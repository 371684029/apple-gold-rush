# GoldRush — 黄金投资研究 Agent

一个 CLI 工具，一条命令自动采集金价数据、四维度分析、强制反驳、回测校准，输出**短期+中长期双视角**策略报告。

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
# 查看实时金价
node dist/index.js price

# 综合分析报告（默认双视角）
node dist/index.js analysis

# 导出 Markdown 投资日报（人类可读，便于存档/分享）
node dist/index.js analysis --md

# 只看短期视角
node dist/index.js analysis -H short

# 只看中长期视角
node dist/index.js analysis -H mid

# 基金对比分析
node dist/index.js fund

# 回测校准
node dist/index.js calibrate

# 查看历史数据
node dist/index.js history

# 生成 Markdown 报告（保存到 docs/ 目录）
node dist/index.js analysis --md
```

建议设置 alias 方便使用：

```bash
alias goldrush="node /path/to/goldRush/dist/index.js"
goldrush price
goldrush analysis
```

---

## 命令一览

| 命令 | 说明 | 优先级 |
|------|------|--------|
| `goldrush price` | 实时金价速查，自动存 SQLite | P0 |
| `goldrush analysis` | 综合分析报告（四维度+反驳+情景+双轨策略） | P1 |
| `goldrush analysis -H short` | 仅短期视角（日线/入场止损） | P1 |
| `goldrush analysis -H mid` | 仅中长期视角（周线/定投加减仓） | P1 |
| `goldrush analysis --json` | JSON 格式输出 | P1 |
| `goldrush analysis --save` | 保存报告到文件 (JSON) | P1 |
| `goldrush analysis --md` | 保存报告为 Markdown 到 docs/ 目录 | P1 |
| `goldrush fund` | 黄金基金对比（费率/溢价/定投信号） | P1 |
| `goldrush calibrate` | 回测校准（历史准确率统计） | P1 |
| `goldrush calibrate --days 90` | 回顾 90 天 | P1 |
| `goldrush snapshot` | 手动保存当日数据快照 | P1 |
| `goldrush init-history` | 首次拉取历史数据 | P1 |
| `goldrush history` | 查看历史金价 | P1 |
| `goldrush history --type reports` | 查看历史分析报告 | P1 |

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
    ├──→ 数据采集 Agent (deepseek-v4-flash)
    │     搜索: Tavily + opencode websearch (fallback)
    │     交叉验证 + 来源分级 (A/B/C)
    │
    ├──→ 四维度分析 (glm-5.1 × 4)
    │     ├── 技术面 (本地计算 MA/RSI/MACD + LLM 解读)
    │     ├── 基本面 (美元/美债/美联储)
    │     ├── 情绪面 (央行购金/CFTC/VIX/地缘)
    │     └── 基金面 (费率/溢价/估值水位)
    │
    ├──→ 强制反驳 Agent (glm-5.1, 独立 session)
    │     专门找看空论据，客观指标判定反驳强度
    │     评分修正: weak=10% / moderate=20% / strong=35%
    │
    └──→ 综合编排 Agent (glm-5.1)
          注入校准上下文 + 三情景分析 + 尾部风险
          输出双轨策略: 短期入场止损 + 中长期定投加减仓
```

---

## 核心设计

### 双引擎搜索

| 数据类型 | 搜索引擎 | 原因 |
|---------|---------|------|
| 国际金价 XAU/USD | Tavily | 金融分类搜索 |
| COMEX/美联储/美债 | Tavily | 英文金融数据覆盖好 |
| 上海金/ETF/基金 | Tavily + opencode fallback | 中文数据源覆盖好 |
| 央行购金/地缘风险 | Tavily | 中英文兼顾 |

### 信息可靠性五道防线

1. **来源分级** — A级(交易所/央行) > B级(财经媒体) > C级(自媒体)
2. **3源交叉验证** — 同一数据至少3个独立来源
3. **中英文双搜** — 避免单一信息茧房
4. **反向核查** — 重大新闻必须搜反对观点
5. **时效标注** — 每个数据标注获取时间和来源

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
最终输出: 64 分 + 反驳摘要 + 尾部风险
```

### 双视角输出

| 维度 | 短期 | 中长期 |
|------|------|--------|
| 时间框架 | 日线/小时线 | 周线/月线 |
| 持仓周期 | 数天~2周 | 1~6个月 |
| 推荐品种 | 518880 场内ETF | 000216/002610 联接基金 |
| 策略核心 | 入场点位、止盈止损 | 定投节奏、加减仓 |
| 风控方式 | 固定止损 3-5% | 估值止盈、仓位管理 |

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

## 历史报告

运行 `analysis --md` 会在 `docs/` 目录生成当日 Markdown 报告：

```bash
node dist/index.js analysis --md    # 生成 docs/goldrush-analysis-YYYY-MM-DD.md
```

报告包含完整四维度分析、强制反驳、双轨策略和尾部风险，可直接用于发文章或归档查阅。每次分析也自动存入 SQLite（`analysis_reports` 表），可通过 `history --type reports` 查看。

启动内置 HTTP 服务即可在浏览器查看所有报告：

```bash
node server.cjs
# → http://localhost 或服务器 IP: http://106.14.92.235
```

### 每日定时分析

已在服务器设置每日 11:30 自动执行分析并生成 Markdown 报告（cron）：

```bash
crontab -l
# 30 11 * * * /root/git/goldRush/scripts/daily-analysis.sh
```

日志文件在 `logs/daily-YYYY-MM-DD.log`，报告自动保存到 `docs/` 目录。

---

## 本地数据存储

SQLite 数据库自动创建在 `data/goldrush.db`：

| 表 | 用途 |
|----|------|
| `gold_prices` | 每日金价快照（伦敦金/上海金/ETF/美元/美债） |
| `fund_nav` | 基金净值快照（000216/002610 等） |
| `analysis_reports` | 分析报告存档（含完整 JSON） |
| `scenario_features` | 市场特征向量（用于历史模式匹配） |
| `search_cache` | 搜索缓存（5分钟内免重复请求） |

每次运行 `price` 或 `analysis` 自动存数据，无需手动操作。

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

数据积累 20 天后技术指标自动生效，注入技术面 Agent prompt。

---

## 项目结构

```
goldRush/
├── src/
│   ├── index.ts              # CLI 入口 (Commander.js)
│   ├── commands/
│   │   ├── price.ts          # 实时金价
│   │   ├── analysis.ts       # 综合分析报告
│   │   ├── fund.ts           # 基金对比
│   │   ├── calibrate.ts      # 回测校准
│   │   ├── snapshot.ts       # 数据快照
│   │   └── history.ts        # 历史数据
│   ├── agents/
│   │   ├── base.ts           # Agent 基类 (opencode CLI)
│   │   ├── data-collector.ts # 数据采集 + 双引擎搜索
│   │   ├── validator.ts      # 信息验证 + 来源分级
│   │   ├── analysis-agents.ts# 四维度 Agent (技术/基本/情绪/基金)
│   │   ├── rebuttal.ts       # 强制反驳 Agent
│   │   └── orchestrator.ts   # 综合编排 Agent
│   ├── data/
│   │   ├── search-router.ts  # Tavily 搜索封装及路由
│   │   ├── opencode-search.ts# opencode 搜索封装
│   │   └── search-router.ts  # 搜索路由器
│   ├── db/
│   │   ├── index.ts          # SQLite 初始化
│   │   ├── gold-prices.ts    # 金价 CRUD
│   │   ├── fund-nav.ts       # 基金净值 CRUD
│   │   ├── reports.ts        # 报告存档 CRUD
│   │   ├── scenario-features.ts # 特征向量 CRUD
│   │   ├── search-cache.ts   # 搜索缓存
│   │   └── calibration.ts    # 校准回测逻辑
│   ├── indicators/
│   │   ├── ma.ts             # 均线
│   │   ├── rsi.ts            # RSI
│   │   ├── macd.ts           # MACD
│   │   ├── bollinger.ts      # 布林带
│   │   └── percentile.ts     # 历史百分位
│   ├── types/                # TypeScript 类型定义
│   └── utils/                # 工具函数
├── data/
│   └── goldrush.db           # SQLite (自动创建)
├── docs/                     # Markdown 分析报告 (analysis --md)
├── scripts/
│   └── daily-analysis.sh     # 每日定时分析脚本 (cron 11:30)
├── logs/                     # 定时运行日志
├── package.json
├── tsconfig.json
└── PLAN.md                   # 完整规划文档
```

---

## 技术栈

| 组件 | 选型 | 原因 |
|------|------|------|
| 语言 | TypeScript | 类型安全 |
| CLI | Commander.js | 成熟稳定 |
| LLM | opencode CLI (`opencode run -m`) | Go 套餐 $10/月封顶 |
| 搜索(联网) | Tavily | 金融分类搜索、内容提取 |
| 搜索(中文) | opencode websearch | 中文数据源覆盖好 |
| 数据库 | SQLite (better-sqlite3) | 零配置、本地、够用 |
| 终端输出 | chalk + cli-table3 | 表格+颜色 |
| 报告展示 | 内置 HTTP 服务 (server.cjs) | 端口80 文件列表页 |

### 启动报告展示页

```bash
node server.cjs
# 访问 http://localhost 查看 docs/ 下所有报告
```

---

## 开发

```bash
# 开发模式（直接运行 TS）
npm run dev -- price

# 编译
npm run build

# 类型检查
npm run lint
```

---

## 文档

| 文档 | 内容 |
|------|------|
| [PLAN.md](./PLAN.md) | 完整项目规划（架构、数据流、类型定义、prompt 设计） |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构决策记录（为什么这样设计） |
| [CORRECTNESS-SPEC.md](./CORRECTNESS-SPEC.md) | 正确率改进规范（回测校准、强制反驳、情景分析） |
| [METHODOLOGY-DEEP-DIVE.md](./METHODOLOGY-DEEP-DIVE.md) | 金融 AI 方法论深度分析（6种范式对比） |
| [PARADIGMS.md](./PARADIGMS.md) | 金融 Agent 架构范式参考 |

---

## 注意事项

- 本工具仅供投资研究参考，**不构成投资建议**
- LLM 分析存在固有局限，请结合自身判断做出决策
- 数据依赖搜索结果，可能存在延迟或偏差
- 建议积累 20 天以上数据后再使用 `calibrate` 命令
- Tavily API 免费额度 1000 次/月，每次 analysis 约消耗 8-12 次搜索
