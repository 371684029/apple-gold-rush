# GoldRush — 黄金投资研究 Agent 完整规划

## 1. 项目概述

| 项 | 值 |
|---|---|
| 项目名 | GoldRush |
| 路径 | `D:\ai\goldrush` |
| 语言 | TypeScript (Node.js) |
| 包管理 | pnpm |
| LLM | opencode Go 套餐（`@opencode-ai/sdk`） |
| 交互 | CLI（Commander.js） |
| 数据获取 | **Tavily（联网金融搜索）+ opencode websearch（fallback）** |
| 投资视角 | **双视角：短期（日线级别）+ 中长期（周/月线级别）** |
| 核心品种 | 短期：黄金ETF场内(518880)；中长期：ETF联接(000216/002610)、积存金 |

### 1.1 投资定位

GoldRush 同时覆盖**短期**和**中长期**两个视角，一份报告双轨输出：

| 维度 | 短期视角 | 中长期视角 |
|------|---------|-----------|
| 时间维度 | 日线/小时线（持仓数天~2周） | 周线/月线（持仓1~6个月） |
| 操作平台 | 黄金ETF场内(518880)、纸黄金 | 支付宝基金（ETF联接、积存金） |
| 策略核心 | 入场点位、止盈止损 | 定投节奏 + 波段加减仓 |
| 分析周期 | 日K、小时线、MACD/RSI短线信号 | 周K/月K、均线趋势、估值水位 |
| 风控方式 | 固定止损（3-5%）、快进快出 | 仓位管理、分批建仓、估值止盈 |
| 推荐品种 | 518880（场内ETF） | 000216/002610（联接A/C）、积存金 |

默认输出两个视角，用 `--horizon short` 或 `--horizon mid` 可只看单视角。

---

## 2. 核心架构

```
用户输入 CLI 命令
        │
        ▼
┌─── Commander.js ───┐
│  price / analysis   │
│  fund / strategy    │
│  daily / macro      │
└────────┬────────────┘
         │
         ▼
┌─── Orchestrator ─────────────┐
│  创建 opencode session        │
│  编排子Agent并行/串行调用     │
│  ← 注入信息可信度验证逻辑 →  │
└────────┬────────────────────┘
         │
    ┌────┼────┐────┐
    ▼    ▼    ▼    ▼
┌────┐┌────┐┌────┐┌─────┐
│数据││技术││情绪││基金  │  ← 各子Agent通过
│采集││面  ││面  ││面    │    @opencode-ai/sdk
│+验证││    ││    ││(新增)│    调用LLM+双引擎搜索
└──┬─┘└──┬─┘└──┬─┘└──┬──┘
   │      │     │      │
   │  ┌───┴─────┴──┐   │
   │  │ 混合搜索层  │   │
│  │ Tavily ←→ opencode   │
│  │ (主引擎)  (fallback) │
   │  └───┬─────┬──┘   │
   │      │     │       │
   └──────┼─────┼───────┘
          ▼     ▼
    ┌──────────────┐
    │综合编排       │  ← 汇总四维度分析
    │Agent         │    输出双轨策略建议
    └──────────────┘
```

**架构变化**：
- 新增 **基金面Agent**：专门分析支付宝平台黄金基金品种、溢价折价、费率对比
- 新增 **搜索层**：Tavily 负责联网金融数据搜索，opencode websearch 作为兜底 fallback
- 数据采集Agent 增加 **信息验证** 子流程：多源交叉验证 + 来源分级
- 技术面Agent 产出 **双轨分析**：短期（日线）+ 中长期（周线）两套指标
- 综合编排Agent 输出 **双轨策略**：短期入场/止损 + 中长期定投/加减仓
- 用户可通过 `--horizon short|mid|all` 控制输出视角

---

## 3. LLM 调用方式

### 使用 `@opencode-ai/sdk`

```typescript
import { createOpencode } from "@opencode-ai/sdk"

// 创建客户端（会启动本地 opencode server）
const { client } = await createOpencode()

// 创建会话
const session = await client.session.create({
  body: { title: "goldrush-analysis" }
})

// 发送 prompt（指定 opencode-go 套餐模型）
const result = await client.session.prompt({
  path: { id: session.id },
  body: {
    model: { providerID: "opencode-go", modelID: "glm-5.1" },
    parts: [{ type: "text", text: promptContent }]
  }
})

// 结构化输出
const structured = await client.session.prompt({
  path: { id: session.id },
  body: {
    model: { providerID: "opencode-go", modelID: "glm-5.1" },
    parts: [{ type: "text", text: "分析黄金技术面..." }],
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          score: { type: "number" },
          direction: { type: "string" },
          keyLevels: { type: "object" },
          summary: { type: "string" }
        },
        required: ["score", "direction", "summary"]
      }
    }
  }
})
```

### LLM 路由策略

| Agent | providerID | modelID | 原因 |
|-------|-----------|---------|------|
| 数据采集 + 验证 | opencode-go | deepseek-v4-flash | 简单提取+比对，速度快 |
| 技术面分析 | opencode-go | glm-5.1 | 推理质量好 |
| 基本面分析 | opencode-go | glm-5.1 | 推理质量好 |
| 情绪面分析 | opencode-go | glm-5.1 | 推理质量好 |
| 基金面分析 | opencode-go | glm-5.1 | 需综合判断 |
| 综合编排 | opencode-go | glm-5.1 | 核心研判 |

### 关键优势

- **websearch 内置**：opencode 自带 websearch/webfetch 工具，Agent 可直接搜索实时数据
- **结构化输出**：SDK 支持 JSON Schema 格式化输出，确保分析结果可解析
- **月费封顶**：Go 套餐 $10/月，不用担心 token 费用暴增
- **会话管理**：每个分析创建独立 session，可追溯、可回看

---

## 3.5 搜索架构（Tavily + opencode fallback）

### 为什么选择 Tavily 单引擎？

初始方案评估过 Exa + opencode 双引擎路由，但实际实现后发现 Tavily 单引擎已满足全部需求：

| 需求 | Tavily | opencode websearch (fallback) |
|------|--------|------------------------------|
| 英文金融数据 | ✅ 内置 `finance` topic，覆盖美联储/COMEX | ❌ 中文引擎为主 |
| 中文A股/基金数据 | ✅ 中文搜索覆盖好 | ✅ 兜底备用 |
| 结构化输出 | ✅ Tavily 原生返回结构化 content | ❌ 需LLM提取 |
| Token 节省 | ✅ AI 摘要，只返回相关内容 | ❌ 返回全文 |
| 新闻搜索 | ✅ 内置新闻搜索 | ✅ 备用 |
| 免费额度 | ✅ 1000请求/月 | ✅ opencode Go 套餐内含 |

**结论：放弃双引擎路由，采用 Tavily 单引擎 + opencode websearch 作为兜底 fallback。** 降低架构复杂度，减少维护成本。

### 搜索策略

| 数据类型 | 搜索方式 | 说明 |
|---------|---------|------|
| 国际金价 (XAU/USD) | Tavily `finance` topic | Tavily 直接查询 |
| COMEX 期货 | Tavily `finance` topic | Tavily 覆盖 |
| 美联储/美债/TIPS | Tavily `finance` topic | Tavily 覆盖 |
| 上海金 Au99.99 | Tavily 中文搜索 | Tavily 中文覆盖好 |
| 黄金ETF净值 (518880) | Tavily 中文搜索 | Tavily 中文覆盖好 |
| 黄金基金净值 (000216等) | Tavily 中文搜索 | Tavily 中文覆盖好 |
| 基金费率/溢价 | Tavily 中文搜索 | Tavily 中文覆盖好 |
| 美元指数 DXY | Tavily `finance` topic | Tavily 覆盖 |
| 地缘风险 | Tavily 新闻搜索 | Tavily 中英文兼顾 |
| 央行购金 | Tavily 新闻搜索 | Tavily 中英文兼顾 |
| 金矿股/GDX | Tavily `finance` topic | Tavily 覆盖 |

失败降级：任何搜索失败时自动 fallback 到 opencode websearch。

### Tavily 集成方式

```typescript
import { tavily } from '@tavily/core'

const client = tavily({ apiKey: process.env.TAVILY_API_KEY })

// 金融数据搜索（内置 finance topic，自动提取关键内容）
const result = await client.search("gold spot price XAUUSD today", {
  maxResults: 5,
  topic: "finance",
  searchDepth: "basic",
})

// 新闻搜索
const newsResult = await client.search("gold price geopolitical risk", {
  maxResults: 5,
  topic: "news",
  searchDepth: "basic",
})

// 搜索结果自动包含 title, url, content, publishedDate
```

### 搜索路由实现

```typescript
// src/data/search-router.ts
// 当前实现使用单一搜索引擎 Tavily（@tavily/core）。
// 未配置 TAVILY_API_KEY 时自动降级为空结果（不抛错）。
export class SearchRouter {
  private client: TavilyClient | null;

  constructor(tavilyApiKey: string) {
    this.client = tavilyApiKey ? tavily({ apiKey: tavilyApiKey }) : null;
  }

  async search(query: string, options = {}): Promise<SearchResult[]> {
    if (!this.client) return [];

    const res = await this.client.search(query, {
      maxResults: options.numResults ?? 5,
      topic: 'finance',
      searchDepth: 'basic',
    });

    return res.results.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      engine: 'tavily',
      publishedDate: r.publishedDate,
      sourceGrade: gradeSource(hostnameOf(r.url)),
    }));
  }
}
```

---

## 3.6 本地历史数据存储（SQLite）

### 为什么需要本地存储？

| 需求 | 只靠搜索的问题 | 本地存储的解决方案 |
|------|----------------|-------------------|
| 均线计算 | MA20需要20天连续数据，搜索拿不到完整序列 | 每日快照存库，直接计算 |
| RSI/MACD | 需要14~26天历史价格 | 本地积累后自算 |
| 趋势对比 | "本周vs上周"需要历史参考 | 查库即得 |
| 分析回溯 | 无法验证过去研判是否准确 | 存储历史报告，可回看 |
| 离线降级 | 搜索失败时完全没数据 | 本地最近快照可应急 |
| 估值水位 | 需要历史百分位数据 | 日积月累越来越准 |

### 数据库设计（SQLite）

```sql
-- 每日金价快照
CREATE TABLE gold_prices (
  date        TEXT PRIMARY KEY,        -- 日期 YYYY-MM-DD
  london_close REAL,                  -- 伦敦金收盘价 (USD/oz)
  london_high  REAL,                  -- 伦敦金最高价
  london_low   REAL,                  -- 伦敦金最低价
  shanghai_close REAL,               -- 上海金收盘价 (CNY/g)
  shanghai_high  REAL,
  shanghai_low   REAL,
  etf_nav     REAL,                   -- 518880 净值
  etf_change  REAL,                   -- 518880 涨跌幅 (%)
  dollar_index REAL,                  -- 美元指数
  us10y_yield  REAL,                  -- 10年期美债收益率 (%)
  tips_yield   REAL,                  -- TIPS 实际利率 (%)
  created_at  TEXT DEFAULT (datetime('now'))
);

-- 基金净值快照
CREATE TABLE fund_nav (
  date        TEXT,
  code        TEXT,                    -- 基金代码 (000216/002610等)
  nav         REAL,                   -- 单位净值
  acc_nav     REAL,                   -- 累计净值
  change_pct  REAL,                   -- 涨跌幅 (%)
  premium     REAL,                   -- 溢价率 (%)
  PRIMARY KEY (date, code)
);

-- 分析报告存档
CREATE TABLE analysis_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT,                    -- 报告日期
  horizon     TEXT,                    -- short | mid | all
  report_json TEXT,                    -- 完整报告 JSON
  overall_score INTEGER,              -- 综合评分
  direction   TEXT,                    -- bullish | bearish | neutral
  created_at  TEXT DEFAULT (datetime('now'))
);

-- 搜索缓存（避免重复请求）
CREATE TABLE search_cache (
  query_hash  TEXT PRIMARY KEY,        -- 查询关键词hash
  query       TEXT,                    -- 原始查询
  engine      TEXT,                    -- exa | opencode
  results     TEXT,                    -- JSON结果
  created_at  TEXT DEFAULT (datetime('now')),
  expires_at  TEXT                     -- 过期时间
);

-- 市场特征向量（用于历史模式匹配和回测校准）
CREATE TABLE scenario_features (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT,                    -- 日期 YYYY-MM-DD
  report_id   INTEGER,                -- 关联 analysis_reports.id
  -- 10维特征向量
  dollar_direction    TEXT,           -- 'up' | 'down' | 'flat'
  dollar_magnitude    REAL,           -- 美元变动幅度
  tips_direction      TEXT,           -- 'up' | 'down' | 'flat'
  tips_magnitude      REAL,           -- TIPS变动幅度
  gold_deviation      REAL,           -- 金价偏离均线程度(%)
  vix_level           REAL,           -- VIX水平
  fed_stance          TEXT,           -- 'hawkish' | 'dovish' | 'neutral'
  geopolitical_risk   TEXT,           -- 'high' | 'medium' | 'low'
  momentum_direction  TEXT,           -- 'up' | 'down' | 'flat'
  consecutive_days    INTEGER,       -- 连续涨跌天数
  -- 回测回填（T+5日更新）
  actual_5d_return     REAL,           -- 后5日实际涨跌幅(%)
  actual_5d_direction  TEXT,          -- 'up' | 'down' | 'flat'
  actual_20d_return   REAL,           -- 后20日实际涨跌幅(%)
  backfill_status     TEXT DEFAULT 'pending',  -- 'pending' | 'filled'
  created_at  TEXT DEFAULT (datetime('now'))
);
```

### 数据积累策略

```
每日自动数据积累（goldrush daily 命令触发或手动 goldrush snapshot）：

1. 每次运行 goldrush price/analysis 时：
   - 自动将当日金价快照写入 gold_prices 表
   - 自动将基金净值写入 fund_nav 表
   - 如果当日数据已存在，跳过或更新

2. 历史数据初始化（首次运行）：
   - goldrush init-history
   - 通过 opencode websearch 拉取最近60天历史数据
   - 填充 gold_prices 和 fund_nav 表

3. 分析报告自动存档：
   - goldrush analysis 运行后自动存入 analysis_reports
   - 可通过 goldrush history 查看历史研判

4. 搜索缓存：
   - 相同查询5分钟内从缓存返回
   - 减少重复搜索，节省 API 调用次数
```

### 历史数据在分析中的使用

```typescript
// 技术面分析时，从本地数据库读取历史序列
const priceHistory = await db.getGoldPrices(days: 60)

// 计算均线
const ma20 = calculateMA(priceHistory.map(p => p.london_close), 20)
const ma60 = calculateMA(priceHistory.map(p => p.london_close), 60)

// 计算 RSI
const rsi = calculateRSI(priceHistory.map(p => p.london_close), 14)

// 计算 MACD
const macd = calculateMACD(priceHistory.map(p => p.london_close))

// 注入技术面Agent的prompt中作为客观数据
// 而非让LLM从搜索结果中猜测均线位置
```

---

## 4. 信息可靠性保障机制

### 4.1 来源分级制度

所有搜索数据按可信度分为三级：

| 级别 | 定义 | 来源示例 | 使用方式 |
|------|------|---------|---------|
| **A级（权威）** | 官方交易所、央行、监管机构 | 上海黄金交易所、COMEX、美联储、世界黄金协会 | 直接采信，作为基准数据 |
| **B级（可信）** | 头部财经媒体、专业数据平台 | 金十数据、东方财富、Wind、华尔街见闻、财联社、证券时报 | 采信但需交叉验证 |
| **C级（参考）** | 自媒体、论坛、个人博客 | 雪球帖子、微博观点、知乎回答 | 不作为决策依据，仅了解情绪 |

### 4.2 交叉验证规则

**规则一：价格数据必须3源验证**

```
同一数据点（如伦敦金现价），必须搜索至少3个独立来源：
  搜索1: "国际金价 伦敦金 今日行情" → 来源A（金十）
  搜索2: "黄金价格 实时 美元/盎司" → 来源B（东方财富）
  搜索3: "XAUUSD spot price today" → 来源C（英文源）

验证逻辑：
  - 3源一致 → 直接采信，标注 ✅
  - 2源一致，1源偏差<0.5% → 取均值，标注 ⚠️ 偏差说明
  - 3源差异>1% → 数据可疑，标注 ❌ 在输出中提示用户确认
```

**规则二：新闻/观点必须反向核查**

```
重大新闻/观点出现时：
  搜索正向: "{新闻关键词}" → 获取主流解读
  搜索反向: "{新闻关键词} 反对 质疑 风险" → 寻找对立观点
  
  在输出中必须呈现：
  - 正方论据（2-3条）
  - 反方论据（至少1条）
  - 数据来源标注
```

**规则三：数据时效性校验**

```
每个数据点必须包含：
  - 数据值
  - 数据时间（精确到小时）
  - 来源名称
  - 可信度等级（A/B/C）

时效性规则：
  - 价格数据：> 4小时 → 标注 "⚠️ 数据可能过时"
  - 利率/CPI数据：> 1天 → 正常（宏观数据更新频率低）
  - 新闻：> 3天 → 标注日期提醒
```

### 4.3 Prompt 内嵌入验证指令

在数据采集 Agent 的提示词中，硬编码以下规则：

```markdown
## 信息可靠性规则（必须遵守）

1. **严禁捏造数据**：只使用搜索到的真实数据，不得编造或推测
2. **多源验证**：每个关键数据点至少搜索2-3个不同来源交叉验证
3. **来源分级**：
   - A级（权威）：交易所、央行、监管机构 → 直接采信
   - B级（可信）：金十、东方财富、华尔街见闻 → 采信但标注来源
   - C级（参考）：自媒体、论坛 → 仅作情绪参考，不用于判断
4. **反向核查**：对重大新闻/观点，必须搜索对立观点
5. **时效标注**：所有数据必须标注获取时间和来源
6. **一致性检查**：如多个来源数据差异超过阈值，在输出中标注 ⚠️
7. **语言切换**：重要数据搜索时，必须同时搜索中英文来源，避免单一信息茧房
```

### 4.4 信息茧房防护

```
搜索策略：
  - 中英文双搜：同一主题同时搜索中文和英文来源
  - 多视角搜索：每条重大信息至少搜1个反对/质疑视角
  - 来源差异化：避免所有数据来自同一平台
  
示例：
  搜中文: "美联储 降息 黄金影响 2026年6月"
  搜英文: "Fed rate cut gold impact June 2026"
  反向搜: "加息 黄金利好 质疑 反对 2026"
```

---

## 5. 中期配置策略框架

### 5.1 核心品种

**短期品种（场内，T+0，适合短线）：**

| 品种 | 代码 | 类型 | 特点 | 场景 |
|------|------|------|------|------|
| 华安黄金ETF | 518880 | 场内ETF | 流动性好、实时交易 | 短线波段 |
| 博时黄金ETF | 518860 | 场内ETF | 备选 | 短线波段 |

**中长期品种（场外基金，支付宝可买，适合定投/中长期持有）：**

| 品种 | 代码 | 类型 | 特点 | 场景 |
|------|------|------|------|------|
| 华安黄金易ETF联接A | 000216 | ETF联接(场外) | 费率低、适合长持 | 中长期定投基础仓 |
| 华安黄金易ETF联接C | 000217 | ETF联接(场外) | 短持费率更优 | 中期波段加减仓 |
| 博时黄金ETF联接A | 002610 | ETF联接(场外) | 跟踪误差小 | 中长期定投基础仓 |
| 博时黄金ETF联接C | 002611 | ETF联接(场外) | 短持费率更优 | 中期波段加减仓 |
| 易方达黄金ETF联接A | 002964 | ETF联接(场外) | 备选 | 分散配置 |
| 积存金（支付宝） | — | 账户黄金 | 门槛低、适合定投 | 小额定投入门 |

**注**：A类适合长期持有（>1年，无销售服务费但有申购费），C类适合中短期波段（<1年，有销售服务费但无申购费）。

### 5.2 策略体系（双轨并行）

```
策略层级：
┌─────────────────────────────────────────────────────────┐
│  短期策略（日线级别，持仓数天~2周）                     │
│  ─────────────────────────────────────                   │
│  ─ 操作品种：黄金ETF场内(518880)、纸黄金               │
│  ─ 入场信号：日线MACD金叉、RSI超卖回升等               │
│  ─ 出场策略：目标位止盈 + 固定止损(3-5%)                │
│  ─ 快进快出，不恋战                                     │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  中长期策略（周线级别，持仓1~6个月）                    │
│  ─────────────────────────────────────                   │
│  ─ 第一层：定投基础仓（60-70%）                        │
│  │  ─ 积存金 或 000216/002610 定投                     │
│  │  ─ 不择时，持续投入                                 │
│  ─ 第二层：波段加减仓（30-40%）                        │
│  │  ─ 金价处于周线支撑区 → 加仓                        │
│  │  ─ 金价处于周线阻力区 → 减仓止盈                    │
│  ─ 风控：估值止盈（偏离年线>15%考虑减仓）               │
└─────────────────────────────────────────────────────────┘

两轨关系：
  • 短期和中长期信号可能矛盾（如日线超买但周线看多）
  • 报告中必须同时呈现两方逻辑，由用户自行选择
  • 短期看空不等于中长期看空，反之亦然
```

### 5.3 基金面分析维度

基金面Agent 专门分析支付宝平台视角：

| 分析维度 | 说明 |
|---------|------|
| **溢价折价** | ETF联接基金净值 vs IOPV（参考价值），溢价时不宜买入 |
| **费率对比** | A类 vs C类，根据预计持有期算总成本 |
| **资金流向** | 黄金ETF申赎数据，大额赎回预警 |
| **定投信号** | 支付宝"指数红绿灯"类似逻辑，低估值区间加码 |
| **净值跟踪** | 最近1周/1月/3月/今年净值表现 |
| **基金规模** | 规模<2亿有清盘风险，>100亿流动性好但波动小 |

---

## 6. 目录结构

```
D:\ai\goldrush\
├── src/
│   ├── index.ts                # CLI 入口（Commander.js）
│   ├── commands/
│   │   ├── price.ts            # goldrush price — 实时金价速查
│   │   ├── analysis.ts         # goldrush analysis — 综合分析报告
│   │   ├── fund.ts             # goldrush fund — 基金面分析
│   │   ├── calibrate.ts        # goldrush calibrate — 回测校准（核心功能）
│   │   ├── macro.ts            # goldrush macro — 宏观面（P2）
│   │   ├── technical.ts        # goldrush technical — 技术面（P2）
│   │   ├── sentiment.ts        # goldrush sentiment — 情绪面（P2）
│   │   ├── strategy.ts         # goldrush strategy — 策略建议（P2）
│   │   ├── daily.ts            # goldrush daily — 每日金评（P3）
│   │   ├── snapshot.ts         # goldrush snapshot — 手动保存数据快照（新增）
│   │   └── history.ts          # goldrush history — 查看历史数据/报告（新增）
│   ├── agents/
│   │   ├── base.ts             # Agent 基类
│   │   │   ├── createSession()
│   │   │   ├── prompt(model, content)
│   │   │   ├── structuredPrompt(model, content, schema)
│   │   │   └── cleanup()
│   │   ├── data-collector.ts   # 数据采集Agent（含验证逻辑）
│   │   ├── validator.ts        # 信息验证Agent
│   │   ├── technical-a.ts      # 技术面Agent
│   │   ├── fundamental-a.ts    # 基本面Agent
│   │   ├── sentiment-a.ts     # 情绪面Agent
│   │   ├── fund-a.ts           # 基金面Agent
│   │   ├── rebuttal.ts         # 强制反驳Agent（独立session，系统找看空论据）
│   │   └── orchestrator.ts     # 综合编排Agent（含情景分析+尾部风险+校准注入）
│   ├── data/
│   │   ├── search-router.ts    # 搜索路由（Tavily 主引擎 + opencode fallback）
│   │   └── search-router.ts    # Tavily 搜索客户端封装（@tavily/core）
│   │   ├── opencode-search.ts   # opencode websearch 客户端封装
│   │   └── cache.ts            # 搜索缓存层（内存 + SQLite）
│   ├── db/
│   │   ├── index.ts            # SQLite 数据库初始化
│   │   ├── gold-prices.ts      # 金价快照 CRUD
│   │   ├── fund-nav.ts         # 基金净值 CRUD
│   │   ├── reports.ts          # 分析报告存档 CRUD
│   │   ├── scenario-features.ts # 市场特征向量 CRUD（用于模式匹配和校准）
│   │   ├── calibration.ts      # 校准回测逻辑（评分区间统计、偏差识别）
│   │   ├── search-cache.ts     # 搜索缓存 CRUD
│   │   └── migrations.ts       # 数据库迁移
│   ├── indicators/
│   │   ├── ma.ts               # 均线计算（MA5/MA20/MA60）
│   │   ├── rsi.ts              # RSI 计算
│   │   ├── macd.ts             # MACD 计算
│   │   ├── bollinger.ts        # 布林带计算
│   │   └── percentile.ts       # 历史百分位计算
│   ├── prompts/
│   │   ├── system.md           # 系统提示词
│   │   ├── price-collect.md    # 金价数据采集prompt
│   │   ├── validation.md       # 数据验证prompt
│   │   ├── technical.md        # 技术面分析prompt
│   │   ├── fundamental.md      # 基本面分析prompt
│   │   ├── sentiment.md        # 情绪面分析prompt
│   │   ├── fund.md             # 基金面分析prompt
│   │   ├── rebuttal.md         # 强制反驳prompt（独立session，系统找看空论据）
│   │   └── synthesis.md        # 综合研判prompt（含情景分析+尾部风险+校准注入）
│   ├── types/
│   │   ├── market.ts           # 市场数据类型定义
│   │   ├── analysis.ts         # 分析结果类型定义（含RebuttalAnalysis, TailRisk, Scenarios）
│   │   ├── calibration.ts      # 校准回测类型定义
│   │   ├── fund.ts             # 基金面类型定义
│   │   └── config.ts           # 配置类型定义
│   └── utils/
│       ├── time.ts             # 交易时间判断
│       ├── format.ts           # 终端输出格式化（表格、颜色、对齐）
│       ├── config.ts           # 配置管理
│       └── source-rank.ts      # 来源分级+交叉验证工具
├── data/
│   └── goldrush.db             # SQLite 数据库文件（自动创建）
├── docs/
│   └── PLAN.md                 # 本规划文档
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
```

---

## 7. CLI 命令设计

```bash
# P0: 实时金价速查
goldrush price
goldrush price --detail          # 更详细的多市场数据

# P1: 综合分析报告（默认输出双视角：短期 + 中长期）
goldrush analysis
goldrush analysis --horizon short  # 只看短期视角（日线、入场止损）
goldrush analysis --horizon mid    # 只看中长期视角（周线、定投加减仓）
goldrush analysis --horizon all    # 双视角（默认）
goldrush analysis --json          # 输出 JSON 格式（便于程序化处理）
goldrush analysis --save           # 保存报告到文件

# P1: 基金面专项
goldrush fund                     # 黄金基金对比分析（费率/溢价/定投信号）

# P1: 回测校准（核心功能：验证历史分析准确率）
goldrush calibrate                # 默认回顾30天分析 vs 实际走势
goldrush calibrate --days 90     # 回顾90天
goldrush calibrate --days 180    # 回顾180天
goldrush calibrate --detail       # 按评分区间细分校准

# P1: 数据管理（新增）
goldrush snapshot                 # 手动保存当日数据快照到SQLite
goldrush init-history             # 首次运行：拉取最近60天历史数据
goldrush history                  # 查看本地历史数据和报告

# P2: 单维度分析
goldrush macro                    # 宏观面详解
goldrush technical                # 技术面详解（默认双视角，同上 --horizon）
goldrush sentiment                # 情绪面详解

# P2: 策略
goldrush strategy                 # 中长期配置策略（定投节奏+波段加减仓）
goldrush strategy --short         # 短期交易策略（入场/止盈/止损）

# P3: 每日金评
goldrush daily                    # 每日金评（适合定时任务）
```

---

## 8. 核心工作流

### 8.1 `goldrush price` 工作流

```
用户执行 goldrush price
    │
    ▼
创建 opencode session
    │
    ▼
数据采集Agent（deepseek-v4-flash）
    │  Tavily 搜索（opencode websearch fallback）：
    │    Tavily: "XAUUSD spot price today" → finance topic
    │    opencode: "国际金价 伦敦金 今日行情" → 中文搜索 (fallback)
    │    Tavily: "gold ETF 518880 NAV" → finance topic
    │    opencode: "黄金ETF 518880 最新净值 涨跌幅" → 中文搜索 (fallback)
    │    ...共6-8组搜索
    │  structured output: { london, shanghai, etf, ... }
    │
    ▼
验证Agent（deepseek-v4-flash）
    │  搜索2-3个验证源交叉比对
    │  检查数据一致性、时效性
    │  标注可信度等级（A/B/C）
    │  如有偏差 → 在输出中标注 ⚠️
    │
    ▼
自动保存快照到 SQLite
    │  → gold_prices 表：当日金价快照
    │  → fund_nav 表：当日基金净值
    │  → search_cache 表：搜索结果缓存
    │
    ▼
格式化输出到终端
```

### 8.2 `goldrush analysis` 工作流

```
用户执行 goldrush analysis [--horizon short|mid|all]
    │
    ▼
Step 1: 数据采集 + 验证（deepseek-v4-flash）
    │  Tavily 搜索（opencode websearch fallback）
    │  Tavily: 全局搜索（finance topic, 中英文兼顾）
    │  opencode: 中文数据（上海金/基金净值/国内报道等）(fallback)
    │  部分关键数据双搜交叉验证
    │  交叉验证 → MarketData（附可信度标注）
    │
    ▼
Step 1.5: 加载历史数据（SQLite）
    │  查询最近60天 gold_prices 表
    │  本地计算技术指标：
    │    MA5/MA20/MA60、RSI(14)、MACD、布林带
    │  将客观技术指标注入分析 prompt
    │
    ▼
Step 2: 四维度分析（glm-5.1 × 4）
    │  ┌─ 技术面Agent → TechnicalAnalysis（含shortTerm + midTerm）
    │  │   （结合本地计算的技术指标 + 搜索到的市场解读）
    │  ├─ 基本面Agent → FundamentalAnalysis
    │  ├─ 情绪面Agent → SentimentAnalysis
    │  └─ 基金面Agent → FundAnalysis
    │     （含溢价折价、费率对比、定投信号）
    │
    ▼
Step 2.5: 强制反驳Agent（glm-5.1，独立session）
    │  专门寻找看空论据（至少3条实质性看空理由）
    │  对每条看多论据找漏洞
    │  输出 RebuttalAnalysis（反驳强度、看空论据、调整建议）
    │  如果反驳强度 ≥ moderate → 触发评分修正
    │
    ▼
Step 3: 综合编排Agent（glm-5.1）
    │  输入：四维度分析结果 + 反驳分析 + 市场 + 历史趋势 + 校准数据 + horizon 参数
    │  structured output: GoldAnalysisReport
    │  包含：
    │    三情景分析（基准/上行/下行 + 概率 + 触发条件）
    │    尾部风险评估（至少3项尾部风险 + 概率 + 影响 + 对冲）
    │    校准上下文（该评分区间历史准确率）
    │    两套策略：
    │      短期：入场/止盈/止损 + 推荐场内品种
    │      中长期：定投节奏/加减仓 + 推荐基金品种
    │  （根据 --horizon 参数决定输出范围）
    │
    ▼
自动保存报告到 SQLite
    │  → analysis_reports 表：完整报告 JSON（含场景特征向量）
    │  → scenario_features 表：10维市场特征向量（用于历史模式匹配）
    │  → gold_prices 表：金价快照（如尚未保存）
    │
    ▼
格式化输出到终端
```

### 8.3 `goldrush fund` 工作流（新增）

```
用户执行 goldrush fund
    │
    ▼
数据采集Agent
    │  搜索黄金基金数据：
    │    - "黄金ETF联接 基金净值 000216 002610"
    │    - "黄金ETF 溢价折价 IOPV"
    │    - "黄金基金 费率对比 A类 C类"
    │    - "黄金ETF 资金流向 申赎"
    │
    ▼
验证Agent → 交叉验证数据可信度
    │
    ▼
基金面Agent（glm-5.1）
    │  分析维度：
    │    - 各基金净值/涨跌幅
    │    - A类 vs C类费率对比（按持有期计算总成本）
    │    - 溢价/折价判断
    │    - 资金流向趋势
    │    - 定投信号（估值水位）
    │  structured output: FundAnalysis
    │
    ▼
格式化输出 → 基金对比表格 + 推荐品种
```

### 8.4 `goldrush calibrate` 工作流

```
用户执行 goldrush calibrate [--days N] [--detail]
    │
    ▼
从SQLite读取数据
    │  analysis_reports: 过去N天的分析报告（score, direction）
    │  gold_prices: 对应日期的金价数据
    │  scenario_features: 市场特征向量（如有）
    │
    ▼
计算回测结果
    │  对每条分析报告：
    │    找到报告日期后 T 天的金价走势
    │    记录：预测方向 vs 实际方向
    │    记录：评分 vs 实际涨跌幅
    │
    │  按评分区间分组统计：
    │    60-70分：实际涨概率、平均涨幅、偏差方向
    │    70-80分：...
    │    80-90分：...
    │    90-100分：...
    │
    │  计算风险预警质量：
    │    红灯触发次数 vs 实际大跌次数
    │    漏报率（该亮红灯但没亮）
    │
    ▼
生成校准报告
    │  总体准确率
    │  各评分区间校准曲线
    │  系统偏差识别（乐观/保守）
    │  风险预警命中率
    │  改进建议
    │
    ▼
格式化输出到终端
```

---

## 9. 数据类型定义

### 9.1 市场数据（MarketData）

```typescript
interface MarketData {
  timestamp: string              // 数据时间
  london: {
    price: number                // 伦敦金价格 (USD/oz)
    change: number               // 涨跌幅 (%)
    source: string               // 数据来源
    sourceGrade: 'A' | 'B' | 'C'  // 来源可信度等级
    verifiedAt: string           // 验证时间
  }
  shanghai: {
    price: number                // 上海金价格 (CNY/g)
    change: number
    source: string
    sourceGrade: 'A' | 'B' | 'C'
    verifiedAt: string
  }
  etf: {
    code: string                 // ETF代码 (518880)
    name: string
    nav: number                  // 最新净值
    change: number
    premiumDiscount?: number     // 溢价/折价率 (%)
    source: string
    sourceGrade: 'A' | 'B' | 'C'
    verifiedAt: string
  }
  dollarIndex: {
    value: number                // 美元指数
    change: number
    source: string
    sourceGrade: 'A' | 'B' | 'C'
    verifiedAt: string
  }
  us10y: {
    yield: number                // 10年期美债收益率
    change: number
    source: string
    sourceGrade: 'A' | 'B' | 'C'
    verifiedAt: string
  }
  tips: {
    yield: number                // TIPS 实际利率
    source: string
    sourceGrade: 'A' | 'B' | 'C'
    verifiedAt: string
  }
}

// 验证结果
interface ValidationResult {
  field: string                  // 字段名
  sources: {                     // 来源列表
    value: number | string
    source: string
    grade: 'A' | 'B' | 'C'
    timestamp: string
  }[]
  consensus: 'verified' | 'minor_deviation' | 'major_conflict'
  finalValue: number | string
  confidence: number             // 0-100 置信度
}
```

### 9.2 分析结果

```typescript
interface DimensionAnalysis {
  score: number                  // 0-100 评分
  direction: 'bullish' | 'bearish' | 'neutral'
  keyPoints: string[]            // 关键论点 3-5条
  counterPoints?: string[]       // 反面论据（至少1条）
  summary: string                // 一句话总结
  sources: string[]              // 信息来源列表
}

interface TechnicalAnalysis extends DimensionAnalysis {
  // 短期视角（日线级别）
  shortTerm: {
    timeframe: 'daily'
    support: number                // 日线支撑位
    resistance: number             // 日线阻力位
    trend: string                  // 日线趋势描述
    indicators: {
      ma5: string                 // 5日均线
      ma20: string                // 20日均线
      macd: string                // 日线MACD
      rsi: string                  // 日线RSI
    }
    keySignal: string              // 短线关键信号（如"MACD金叉"）
  }
  // 中长期视角（周线级别）
  midTerm: {
    timeframe: 'weekly'
    support: number                // 周线支撑位
    resistance: number             // 周线阻力位
    trend: string                  // 周线趋势描述
    indicators: {
      ma20w: string               // 20周均线状态
      ma60w: string               // 60周均线（年线）
      macd: string                 // 周线MACD
      rsi: string                  // 周线RSI
    }
    keySignal: string              // 中期关键信号
  }
}

interface FundamentalAnalysis extends DimensionAnalysis {
  dollarIndexEffect: string      // 美元指数影响
  interestRateEffect: string     // 利率影响
  inflationEffect: string        // 通胀影响
  fedStance: string               // 美联储政策倾向
}

interface SentimentAnalysis extends DimensionAnalysis {
  centralBanks: string           // 央行购金动态
  cftcPosition: string           // CFTC持仓
  vix: string                    // 恐慌指数
  geopoliticalRisk: string       // 地缘风险
  etfFlows: string               // 黄金ETF资金流入/流出
}

// 新增：基金面分析
interface FundAnalysis {
  funds: FundComparison[]        // 基金对比列表
  recommendation: {
    longTerm: string              // 长期持有推荐品种
    mediumTerm: string            // 中期波段推荐品种
    dipBuy: string                // 定投推荐品种
  }
  valuation: {
    level: 'low' | 'fair' | 'high'  // 估值水位
    indicator: string               // 判断依据
    action: string                   // 定投操作建议
  }
  premiumDiscount: {
    current: number                  // 当前溢价/折价率
    trend: string                    // 趋势
    advice: string                   // 买入/回避建议
  }
}

interface FundComparison {
  code: string                   // 基金代码
  name: string                   // 基金名称
  type: 'A' | 'C'                // A类/C类
  nav: number                    // 最新净值
  change1w: number               // 近1周涨跌
  change1m: number               // 近1月涨跌
  change3m: number               // 近3月涨跌
  feeRate: number                // 综合费率（%）
  totalCost1y: number            // 持有1年总成本（%）
  totalCost3y: number            // 持有3年总成本（%）
  scale: number                  // 基金规模（亿）
  recommendation: string        // 适用场景
}

interface GoldAnalysisReport {
  timestamp: string
  marketData: MarketData
  dataQuality: {
    overallConfidence: number     // 整体数据置信度 0-100
    warnings: string[]            // 数据质量警告
  }
  technical: TechnicalAnalysis
  fundamental: FundamentalAnalysis
  sentiment: SentimentAnalysis
  fund: FundAnalysis
  rebuttal: RebuttalAnalysis     // 新增：强制反驳
  tailRisks: TailRisk[]          // 新增：尾部风险清单
  overall: {
    score: number                // 综合评分 0-100
    direction: 'bullish' | 'bearish' | 'neutral'
    // 情景分析（替代单一点估计）
    scenarios: {
      base: {
        probability: number      // 基准情景概率（%）
        description: string      // 场景描述
        goldPrice: string        // 预期金价区间
        action: string           // 操作建议
      }
      upside: {
        probability: number      // 上行情景概率（%）
        description: string
        goldPrice: string
        trigger: string          // 触发条件
        action: string
      }
      downside: {
        probability: number      // 下行情景概率（%）
        description: string
        goldPrice: string
        trigger: string
        action: string
      }
    }
    // 校准上下文（来自历史回测数据）
    calibration: {
      scoreRange: string         // 本报告评分所在区间（如"70-80"）
      historicalAccuracy: number | null  // 该区间历史准确率（样本充足时）
      systematicBias: string     // "偏乐观"/"偏保守"/"校准良好"
      sampleSize: number         // 该区间历史样本数
    }
    // 短期视角
    shortTerm: {
      horizon: 'short-term'
      action: string               // 操作建议（如"逢低短线做多"）
      entryZone: string            // 入场区间
      target: string               // 目标位
      stopLoss: string             // 止损位
      recommendedProduct: string   // 推荐品种（如"518880场内ETF"）
      riskWarning: string          // 短期风险提示
    }
    // 中长期视角
    midTerm: {
      horizon: 'medium-term'
      investAdvice: {
        dipInvest: 'continue' | 'increase' | 'pause'  // 定投建议
        positionAdjust: 'add' | 'reduce' | 'hold'      // 仓位调整
        recommendedFund: string                         // 推荐品种（000216等）
      }
      keyLevels: {
        supportZone: string       // 周线支撑区间
        resistanceZone: string    // 周线阻力区间
      }
      riskWarning: string          // 中长期风险提示
    }
  }
}

// 新增：强制反驳分析
interface RebuttalAnalysis {
  bullScore: number              // 乐观方评分
  bearScore: number              // 反驳方评分
  rebuttalStrength: 'weak' | 'moderate' | 'strong'  // 反驳强度
  bearPoints: string[]           // 至少3条实质性看空论据
  bullVulnerabilities: string[] // 乐观论据的漏洞
  netEffect: 'unchanged' | 'downgraded' | 'significant_downgrade'
  adjustedScore?: number        // 如果反驳有效，调整后的评分
}

// 新增：尾部风险
interface TailRisk {
  risk: string                   // 风险描述
  probability: number            // 发生概率（%）
  impact: string                 // 影响描述（如"金价可能跌8%"）
  trigger: string                // 触发条件
  mitigation: string             // 对冲建议
}
```

---

## 10. Prompt 设计原则

### 10.1 通用规则（嵌入每个 prompt）

```markdown
## 信息可靠性规则（必须遵守）

1. 严禁捏造数据，只使用搜索到的真实数据
2. 每个关键数据点至少搜索2-3个不同来源交叉验证
3. 来源分级：
   - A级（权威）：交易所、央行 → 直接采信
   - B级（可信）：金十、东方财富、华尔街见闻 → 采信但标注来源
   - C级（参考）：自媒体、论坛 → 仅作情绪参考
4. 对重大新闻/观点，必须搜索对立观点（至少1条反方论据）
5. 所有数据必须标注获取时间和来源
6. 多来源数据差异>1%时，标注 ⚠️ 提醒
7. 重要数据搜索时，同时搜索中英文来源
```

### 10.2 双视角分析规则（嵌入技术面和综合编排 prompt）

```markdown
## 双视角分析规则

你同时提供短期和中长期两个视角的分析：

### 短期视角（日线级别，持仓数天~2周）
- 分析周期：日K线、小时线
- 技术指标：5日/20日均线、日线MACD、日线RSI
- 操作建议：精确入场区间、止盈目标、止损位
- 推荐品种：黄金ETF场内(518880)、纸黄金
- 风控方式：固定止损（3-5%）

### 中长期视角（周线级别，持仓1~6个月）
- 分析周期：周K线、月K线
- 技术指标：20周/60周均线、周线MACD、周线RSI
- 操作建议：定投节奏调整（加码/维持/暂停）、波段加减仓
- 推荐品种：黄金ETF联接A(000216)长期持有、C(000217)波段、积存金定投
- 风控方式：估值水位判断、仓位管理
```

### 10.3 投资风格规则（嵌入每个 prompt）

```markdown
## 投资风格规则

1. 本Agent同时服务短线交易者和中长期配置者
2. 短期视角以日线/小时线为主，提供入场止损建议
3. 中长期视角以周线/月线为主，提供定投节奏和仓位管理建议
4. 两个视角必须同时呈现，不可偏废
5. 当短期和中长期信号矛盾时（如日线超买但周线看多），必须同时说明两方逻辑
6. 短期推荐场内品种（ETF 518880），中长期推荐场外基金（000216等）
7. 严禁推荐杠杆/期货产品
8. 具体说明持有期适合A类还是C类基金
```

### 10.3 各 prompt 文件结构

每个 prompt 文件遵循以下结构：

```markdown
# {角色定义}
你是黄金投资研究分析师，专精于{技术面/基本面/情绪面/基金面}分析。
你面向的是通过支付宝基金做中期配置的个人投资者。

# {任务说明}
基于以下经过验证的市场数据，进行{维度}分析。

# {输入数据}
{动态注入的市场数据，含来源和可信度标注}

# {输出要求}
请严格按照以下 JSON Schema 输出：
{JSON Schema}

# {可靠性规则}
（嵌入通用可靠性规则）

# {投资风格规则}
（嵌入中期配置导向规则）
```

---

## 11. 数据搜索关键词映射

### 11.1 行情数据（中英文双搜）

| 数据类型 | 中文搜索 | 英文搜索 |
|---------|---------|---------|
| 国际金价 | `国际金价 伦敦金 现货 今日行情 {年月}` | `XAUUSD spot price today` |
| 上海金 | `上海金 Au99.99 Au(T+D) 今日行情` | `Shanghai gold Au99.99 price` |
| 黄金ETF场内 | `黄金ETF 518880 行情 最新净值` | `Gold ETF 518880 NAV China` |
| **短线技术** | `黄金 日线 支撑 阻力 MACD RSI` | `gold daily chart support resistance MACD RSI` |
| **周线技术** | `黄金 周线 均线 趋势 2026` | `gold weekly chart MA trend 2026` |
| 美元指数 | `美元指数 DXY 今日行情` | `US dollar index DXY today` |
| 10年期美债 | `十年期美债收益率 今日` | `US 10 year treasury yield today` |
| TIPS实际利率 | `TIPS 实际利率 10年期 最新` | `10Y TIPS real yield latest` |
| 人民币汇率 | `美元兑人民币 汇率 今日` | `USD CNY exchange rate today` |

### 11.2 情绪/事件数据（含反向搜索）

| 数据类型 | 正向搜索 | 反向搜索 |
|---------|---------|---------|
| 央行购金 | `全球央行购金 黄金储备 {年份}` | `央行售金 黄金减持 {年份}` |
| CFTC持仓 | `CFTC 黄金 非商业净多头 最新` | `CFTC 黄金 空头 增加` |
| 地缘风险 | `黄金 地缘政治 避险 {年月}` | `地缘紧张 缓和 黄金 回调` |
| 金价看多 | `黄金 看多 利好 {年月}` | `黄金 看空 利空 风险 {年月}` |

### 11.3 基金面数据

| 数据类型 | 搜索关键词 |
|---------|-----------|
| 基金净值 | `黄金ETF联接 000216 002610 最新净值` |
| 溢价折价 | `黄金ETF 溢价 折价 IOPV` |
| 费率对比 | `黄金基金 费率对比 A类 C类 管理费 托管费` |
| 资金流向 | `黄金ETF 资金流入 申赎 {年月}` |
| 定投信号 | `黄金 估值 水位 低估 高估 定投 {年月}` |
| 基金规模 | `黄金ETF联接 基金规模 份额变动` |

---

## 12. 终端输出格式

### `goldrush price` 输出

```
══════════════════════════════════════════════
  🥇 GoldRush 实时金价
  2026-06-08 15:30 CST | 交易状态: 夜盘
  数据来源: 金十数据/新浪财经/东方财富
══════════════════════════════════════════════

  品种              价格          涨跌幅     可信度
  ────────────────────────────────────────────────
  伦敦金 (XAU)      $2,678.50     +0.35%     ✅ A级
  上海金 (Au99.99)  ¥618.50/g     +0.42%     ✅ A级
  黄金ETF (518880)   5.612        +0.38%     ✅ B级

  美元指数 (DXY)     103.20       -0.15%     ✅ A级
  10Y美债收益率      4.28%        -0.02%     ✅ B级
  TIPS实际利率       1.82%        --         ⚠️ B级

  数据时间: 2026-06-08 15:20 CST
══════════════════════════════════════════════
```

### `goldrush fund` 输出（新增）

```
════════════════════════════════════════════════════════════
  💰 GoldRush 黄金基金分析
  2026-06-08 | 面向支付宝中期配置
════════════════════════════════════════════════════════════

📊 基金对比
  ──────────────────────────────────────────────────────────
  基金           类型  最新净值  近1月  费率   规模   适合
  ──────────────────────────────────────────────────────────
  华安黄金易A    A类  1.8523   +3.2%  0.60%  85亿   长持(>1年)
  华安黄金易C    C类  1.8520   +3.2%  0.20%  62亿   波段(<1年)
  博时黄金A      A类  1.7890   +3.1%  0.60%  54亿   长持(>1年)
  博时黄金C      C类  1.7888   +3.1%  0.15%  38亿   波段(<1年)
  ──────────────────────────────────────────────────────────

📈 估值水位: 偏低（适合加码定投）
  黄金近3月涨跌幅: +3.2%
  20周均线偏离: -1.8%
  建议: 定投可增加20%金额

💹 溢价折价: 折价0.05%（接近合理，可买入）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🎯 推荐配置
  定投基础仓: 华安黄金易A (000216)
  波段加减仓: 华安黄金易C (000217)
  纯小白无脑: 支付宝积存金（周定投500元起）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### `goldrush analysis` 输出

```
════════════════════════════════════════════════════════════
  🥇 GoldRush 黄金研究报告
  2026-06-08 | 交易时段: 夜盘 | 数据置信度: 92%
════════════════════════════════════════════════════════════

📊 实时行情
  伦敦金    $2,678.50  +0.35%    美元指数    103.20  -0.15%
  上海金    ¥618.5/g   +0.42%    10Y美债     4.28%   -0.02%
  黄金ETF   5.612      +0.38%    TIPS利率    1.82%   --
  000216    1.8523     +0.31%    USD/CNY     7.245   +0.08%

──────────────────────────────────────────────────────────
📈 技术面：偏多（75/100）
  【短期·日线】偏多
    • 站上5/20日均线，日线MACD金叉
    • 日线RSI 62，偏强未超买
    • 支撑：$2,660 | 阻力：$2,700
    ⚠️ 反方：1小时线有顶背离迹象，短线或回调

  【中长期·周线】偏多
    • 站上20周均线，周线MACD金叉
    • 周线RSI 58，中期趋势健康
    • 支撑：$2,580 | 阻力：$2,750

📊 基本面：偏多（70/100）
  • 美元指数回落至103.2，利多黄金
  • TIPS实际利率降至1.82%，中期支撑金价
  • 美联储降息预期增强
  ⚠️ 反方：若通胀反弹，降息推迟可能压制金价

🌡️ 情绪面：中性偏多（60/100）
  • 央行持续净购金（2026Q1增购89吨）
  • CFTC净多头小幅增加
  • VIX 15.2，市场情绪平稳

💰 基金面：偏多（65/100）
  • 000216净值随金价上涨，跟踪正常
  • 当前折价0.05%，买入窗口良好
  • 基金规模稳定（85亿），流动性充足
  • 定投信号：估值偏低区，适合加码

━━━ 🎯 综合研判：偏多（68/100）━━━ 校准参考：70-80分区历史准确率67% ━━━

  ⚡ 情景分析
  ─────────────────────────────────
  基准情景（概率55%）：金价温和上行至$2,710
    → 维持定投
  上行情景（概率25%）：美联储意外降息，金价突破$2,800
    → 定投+加码20%
  下行情景（概率20%）：通胀反弹导致延迟降息，金价回落至$2,580
    → 暂停定投1期，$2,580附近恢复

  ⚠️ 尾部风险（可能导致重大亏损的情景）
  ─────────────────────────────────
  1. 美联储意外加息 → 概率5%，金价可能跌8%
     触发: CPI > 3.5% 且美联储鹰派 | 对冲: 暂停定投1期
  2. 美元指数突破105 → 概率8%，金价可能跌5%
     触发: 欧央行意外鸽派 | 对冲: 减仓10%
  综合尾部风险指数: 13%

  🔴 强制反驳摘要
  ─────────────────────────────────
  反驳强度: 中等 | 看空评分: 42/100
  · 日线RSI 62已偏强，短线有超买回调风险
  · 美联储6月点阵图可能偏鹰，市场尚未定价
  · COMEX净多头处于高位，拥挤交易风险
  → 综合评分从70下调至68

  ─── ⚡ 短期策略（日线级别）────────────────────
  操作: 逢低短线做多
  入场: $2,665-2,675
  目标: $2,700
  止损: $2,645（跌破20日均线离场）
  品种: 黄金ETF场内(518880) / 纸黄金

  ─── 🏦 中长期策略（周线级别）────────────────────
  定投: 继续定投，可增加20%金额
  仓位: 维持6成仓位，支撑区加码
  品种:
    • 定投基础仓 → 华安黄金易A (000216)
    • 波段加仓   → 华安黄金易C (000217)
    • 纯小白定投 → 支付宝积存金
  支撑区: $2,580-$2,620 → 加码区间
  阻力区: $2,750-$2,800 → 减仓区间
════════════════════════════════════════════════════════════

⚠️ 以上不构成投资建议，市场有风险，投资需谨慎
📋 数据来源: 金十数据(A)、东方财富(B)、华尔街见闻(B)
```

当使用 `--horizon short` 时，只输出 "短期策略" 部分；
当使用 `--horizon mid` 时，只输出 "中长期策略" 部分；
默认或 `--horizon all` 输出完整报告。

---

## 13. 交易时间判断

```typescript
// 上海金交易时段
const shanghaiGoldHours = [
  { name: '日盘', start: '09:00', end: '15:30' },
  { name: '夜盘', start: '19:50', end: '02:30+1' }
]

// 伦敦金（几乎24小时，主要时段）
const londonGoldHours = [
  { name: '亚盘', start: '06:00', end: '15:00' },
  { name: '欧盘', start: '15:00', end: '20:30' },
  { name: '美盘', start: '20:30', end: '02:30+1' }
]

// 黄金ETF联接基金（场外申赎时间）
const etfFundHours = [
  { name: '申赎', start: '09:30', end: '15:00' },
  // 注意：场外基金15:00前提交按当日净值，15:00后按次日净值
]
```

---

## 14. 开发阶段规划

### P0: CLI 框架 + `price` 命令 + 数据库（预计 2-3 天）

| 任务 | 说明 |
|------|------|
| 项目初始化 | pnpm init, tsconfig, 依赖安装 |
| CLI 框架 | Commander.js, 注册子命令 |
| Agent 基类 | 封装 `@opencode-ai/sdk`，提供 createSession/prompt/structuredPrompt/cleanup |
| Tavily 客户端 | 封装 `@tavily/core`，实现 Tavily + opencode fallback 搜索 |
| SQLite 初始化 | 建表、迁移脚本、基础 CRUD |
| 数据采集Agent | 搜索多源金价数据（Tavily + opencode fallback） |
| 验证Agent | 交叉验证 + 来源分级 + 可信度标注 |
| price 命令 | 串联数据采集 → 验证 → 自动存快照 → 格式化输出 |
| snapshot 命令 | 手动保存数据快照 |
| init-history 命令 | 首次运行拉取60天历史数据 |
| 终端格式化工具 | 表格、对齐、颜色（chalk） |

### P1: `analysis` + `fund` + `calibrate` 命令（预计 5-7 天）

| 任务 | 说明 |
|------|------|
| 技术指标模块 | MA/RSI/MACD/布林带本地计算（从 SQLite 历史数据） |
| 技术面Agent | 双轨技术分析（日线+周线）prompt + structured output |
| 基本面Agent | 基本面分析 prompt（含反方论据） |
| 情绪面Agent | 情绪面分析 prompt（含反向搜索） |
| 基金面Agent | 基金对比/溢价折价/定投信号 |
| **强制反驳Agent** | 独立session，系统性寻找看空论据，输出 RebuttalAnalysis |
| **情景分析prompt** | 综合编排Agent输出三情景（基准/上行/下行）+ 尾部风险清单 |
| **校准上下文注入** | 综合编排时注入历史校准数据（该评分区间历史准确率） |
| **scenario_features表** | 新建10维市场特征向量表，每次分析存档 |
| 综合编排Agent | 汇总四维度+反驳+校准，输出双轨策略+情景+尾部风险 |
| fund 命令 | 基金面专项分析 |
| analysis 命令 | 完整工作流串联（含反驳步骤），支持 --horizon 参数 |
| **calibrate 命令** | 回测校准：分析历史报告 vs 实际走势，生成分区间校准报告 |
| --json / --save | 输出 JSON / 保存报告到 SQLite |

### P2: 单维度命令 + 策略（预计 2-3 天）

| 任务 | 说明 |
|------|------|
| history 命令 | 查看本地历史数据和分析报告 |
| macro 命令 | 单独宏观面分析 |
| technical 命令 | 单独技术面分析（双视角） |
| sentiment 命令 | 单独情绪面分析 |
| strategy 命令 | 双视角策略（短期入场止损 + 中长期定投加减仓） |
| 搜索缓存 | SQLite 搜索缓存，5分钟 TTL |
| 错误处理 | 搜索失败重试、数据源降级 |

### P3: 定时 + 优化（预计 2-3 天）

| 任务 | 说明 |
|------|------|
| daily 命令 | 每日金评（精简版 analysis + 自动快照） |
| 估值水位 | 基于历史数据的百分位计算 |
| 定投提醒 | 根据估值水位生成定投建议 |
| npm scripts | 配置定时任务脚本 |
| 可靠性优化 | Tavily/opencode 搜索失败自动降级 |

---

## 15. 依赖清单

| 依赖 | 用途 | 类型 |
|------|------|------|
| `commander` | CLI 框架 | runtime |
| `@opencode-ai/sdk` | LLM 调用 + websearch | runtime |
| `@tavily/core` | Tavily 搜索 API（联网金融数据） | runtime |
| `better-sqlite3` | SQLite 数据库（历史数据存储） | runtime |
| `chalk` | 终端颜色 | runtime |
| `cli-table3` | 终端表格 | runtime |
| `dayjs` | 时间处理 | runtime |
| `typescript` | TypeScript 编译 | dev |
| `tsx` | TS 直接运行 | dev |
| `@types/node` | Node.js 类型 | dev |
| `@types/better-sqlite3` | SQLite 类型 | dev |

---

## 16. 配置设计

```jsonc
// goldrush.config.json（项目根目录）
{
  "llm": {
    "provider": "opencode-go",
    "models": {
      "dataCollector": "deepseek-v4-flash",
      "analysis": "glm-5.1"
    }
  },
  "search": {
    "engines": {
      "exa": {
        "apiKey": "",                   // 从环境变量 EXA_API_KEY 读取
        "defaultType": "auto",         // auto | fast | deep | deep-reasoning
        "defaultCategory": "financial report",
        "maxResults": 10,
        "highlights": true,
        "maxCharacters": 2000
      },
      "opencode": {
        "enabled": true                // 使用 opencode SDK 内置 websearch
      }
    },
    "routing": {
      // 数据类型 → 搜索引擎映射
      "london": "both",                // 双搜交叉验证
      "comex": "exa",
      "shanghai": "opencode",
      "etf": "opencode",
      "fund": "opencode",
      "dollarIndex": "exa",
      "us10y": "exa",
      "tips": "exa",
      "centralBanks": "both",
      "geopolitical_en": "exa",
      "geopolitical_zh": "opencode",
      "technical_daily": "opencode",
      "technical_weekly": "both"
    }
  },
  "database": {
    "path": "./data/goldrush.db",      // SQLite 数据库路径
    "historyDays": 365,                  // 保留历史数据天数
    "autoSnapshot": true                // 每次 price/analysis 自动保存快照
  },
  "investment": {
    "horizon": "all",                  // all | short | mid（默认双视角）
    "platform": "alipay",              // 操作平台：支付宝
    "timeframes": {
      "short": {
        "label": "短期",
        "kline": "daily",
        "indicators": ["MA5", "MA20", "MACD", "RSI"],
        "holdingPeriod": "数天~2周",
        "products": ["518880", "纸黄金"]
      },
      "mid": {
        "label": "中长期",
        "kline": "weekly",
        "indicators": ["MA20W", "MA60W", "MACD_W", "RSI_W"],
        "holdingPeriod": "1~6个月",
        "products": ["000216", "000217", "002610", "002611", "积存金"]
      }
    },
    "defaultFunds": [                   // 默认关注基金
      { "code": "000216", "name": "华安黄金易A", "type": "A" },
      { "code": "000217", "name": "华安黄金易C", "type": "C" },
      { "code": "002610", "name": "博时黄金A", "type": "A" },
      { "code": "002611", "name": "博时黄金C", "type": "C" }
    ],
    "etfCodes": ["518880", "518860"]    // 场内ETF代码
  },
  "output": {
    "language": "zh-CN",
    "format": "table"  // table | json | markdown
  },
  "cache": {
    "enabled": true,
    "ttl": 300,          // 5分钟搜索缓存（SQLite）
    "dbTtl": 86400       // 24小时数据库缓存
  },
  "reliability": {
    "minSources": 3,                    // 价格数据最少验证源数
    "conflictThreshold": 0.01,          // 一致性偏差阈值 (1%)
    "sourceGrades": {                   // 来源分级
      "A": ["上海黄金交易所", "COMEX", "美联储", "世界黄金协会"],
      "B": ["金十数据", "东方财富", "华尔街见闻", "财联社", "证券时报", "新浪财经"],
      "C": ["雪球", "微博", "知乎", "个人博客"]
    },
    "requireCounterView": true          // 重大新闻必须搜反向观点
  },
  "dataSources": {
    "london": "金十数据,新浪财经,东方财富",
    "shanghai": "上海黄金交易所,东方财富",
    "etf": "天天基金,东方财富",
    "fund": "天天基金,支付宝基金"
  }
}
```

---

## 17. 待确认项

1. **opencode SDK 日志级别**：需要确认 SDK 是否支持静默模式（不输出 server 启动日志），避免污染 CLI 输出
2. **websearch 工具可用性**：需要确认通过 SDK 创建的 session 是否自动启用 websearch 权限
3. **并发控制**：四维度分析是否可以真正并行（SDK session 是否支持并行 prompt），还是需要串行
4. **Tavily API Key**：需要注册 Tavily 账号获取 API Key（免费1000请求/月），配置到环境变量 `TAVILY_API_KEY`
5. **中文金融数据覆盖**：需要实测 Tavily 对中文金融数据（上海金、基金净值等）的覆盖质量，决定是否需要 opencode fallback 增强
6. **支付宝基金数据**：基金净值/费率数据可能需要天天基金网页爬取，websearch 能否覆盖
7. **历史数据初始化**：`goldrush init-history` 拉取60天历史数据时，Tavily 和 opencode 的免费额度是否够用