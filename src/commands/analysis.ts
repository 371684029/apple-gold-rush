// goldrush analysis — 综合分析报告

import { DataCollectorAgent } from '../agents/data-collector.js';
import { ValidatorAgent } from '../agents/validator.js';
import { TechnicalAgent, FundamentalAgent, SentimentAgent, FundAgent } from '../agents/analysis-agents.js';
import { RebuttalAgent } from '../agents/rebuttal.js';
import { OrchestratorAgent } from '../agents/orchestrator.js';
import { header, separator, directionMark, scoreBar, changeColor, riskLevel, valuationMark, sessionMark } from '../utils/format.js';
import { formatReportMarkdown } from '../utils/report-md.js';
import { computeTailRiskIndex } from '../utils/tail-risk.js';
import { getConfig } from '../utils/config.js';
import { buildScoreBreakdown, extendBreakdownWithCalibration, formatScoreBreakdownConsole, formatScoreBreakdownOneLine } from '../utils/score-breakdown.js';
import { detectMacroRegime, formatMacroRegimeLine } from '../utils/macro-regime.js';
import { buildJudgeVerdict, formatJudgeVerdictConsole } from '../utils/judge-verdict.js';
import { buildLongTermOutlook, formatLongTermOutlookConsole } from '../utils/long-term-outlook.js';
import { findSimilarPatterns } from '../utils/scenario-similarity.js';
import { buildRunManifest, saveRunManifest, wrapAnalysisOutputV1 } from '../utils/run-manifest.js';
import { getDb } from '../db/index.js';
import { ScenarioFeaturesRepo } from '../db/scenario-features.js';
import { ReportsRepo } from '../db/reports.js';
import { forwardFillCloses, latestDeviationFromMA } from '../utils/price-series.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import { ensureGoldPriceHistory, MIN_TRADING_ROWS_FOR_ANALYSIS } from '../utils/ensure-gold-history.js';
import { priceSeriesProxyNote, spotProxyDeviationWarning } from '../utils/price-semantics.js';
import { evaluateAnalysisGate } from '../utils/analysis-gate.js';
import { buildSmartReport, parseReportJson } from '../utils/smart-analysis.js';
import { buildRecentReportsContext } from '../utils/report-history-context.js';
import { resolveOverallScore } from '../utils/overall-score.js';
import { directionFromScore } from '../utils/calibration-adjust.js';
import { countConsecutiveDirectionDays } from '../utils/consecutive-direction.js';
import { buildScenarioFeatureDraft, draftToScenarioFeature } from '../utils/scenario-feature-builder.js';
import { computeScenarioProbabilities } from '../utils/scenario-probability.js';
import { matchCausalChains, formatCausalChainsConsole } from '../utils/gold-causal-rules.js';
import type { OrchestrateOptions } from '../agents/orchestrator.js';
import { todayDate, formatNow } from '../utils/time.js';
import type { Horizon } from '../types/config.js';
import type { GoldAnalysisReport } from '../types/analysis.js';
import type { PatternMatch } from '../types/calibration.js';

export async function analysisCommand(options: {
  horizon: Horizon;
  json: boolean;
  jsonLegacy: boolean;
  save: boolean;
  md: boolean;
  smart: boolean;
}): Promise<number> {
  const startedAt = new Date().toISOString();
  console.log('\n🔬 GoldRush 综合分析启动...\n');

  // Step 0: 自动补齐历史金价（Yahoo GC=F，无需 Tavily）
  console.log('  📜 Step 0: 补齐历史金价 (60 天)...');
  const priceRepo = new GoldPricesRepo(getDb());
  try {
    const hist = await ensureGoldPriceHistory(priceRepo, 60);
    if (hist.filled > 0) {
      console.log(`  ✅ Yahoo 已补 ${hist.filled} 个交易日（共 ${hist.tradingRows} 行，可算 MA/RSI/MACD）`);
    } else if (hist.readyForAnalysis) {
      console.log(`  ✅ 历史金价就绪（${hist.tradingRows} 个交易日）`);
    } else {
      console.log(`  ⚠️ 历史仅 ${hist.tradingRows} 行（需 ≥${MIN_TRADING_ROWS_FOR_ANALYSIS}），指标可能不完整`);
      console.log('  💡 可先运行: goldrush init-history --days 60');
    }
  } catch (err) {
    console.warn('  ⚠️ 历史自动补齐失败:', err instanceof Error ? err.message : err);
    console.warn('  💡 请运行 goldrush init-history --days 60 或检查 Yahoo Finance 网络');
  }

  if (options.smart) {
    const gate = evaluateAnalysisGate(priceRepo.getRecent(5));
    if (gate.mode === 'calm') {
      console.log(`  🧠 Smart 门控：${gate.reason}`);
      const smartExit = await runSmartAnalysis(options, gate, priceRepo, startedAt);
      if (smartExit != null) return smartExit;
      console.log('  ⚡ Smart：无可用上一日报告，转完整分析');
    } else {
      console.log(`  ⚡ Smart：${gate.reason}，运行完整分析`);
    }
  }

  // Step 1: 数据采集 + 验证
  console.log('  📡 Step 1: 采集市场数据...');
  const collector = new DataCollectorAgent();
  let marketData;
  try {
    marketData = await collector.collectMarketData();
  } catch (err) {
    console.error('数据采集失败:', err instanceof Error ? err.message : err);
    await collector.cleanup();
    return 1;
  }

  const validator = new ValidatorAgent();
  const validation = await validator.validate(marketData);
  console.log(`  ✅ 数据采集完成 (置信度: ${validation.overallConfidence}%)`);

  const priceWarnings: string[] = [...validation.warnings];
  priceWarnings.push(priceSeriesProxyNote());
  const latestProxy = priceRepo.getRecent(1)[0]?.londonClose ?? null;
  const spotWarn = spotProxyDeviationWarning(marketData.london?.price?.value, latestProxy);
  if (spotWarn) priceWarnings.push(spotWarn);

  // Step 1.5: 加载历史数据 + 本地指标已在 TechnicalAgent 中处理

  // Step 2: 四维度分析（两批：技术+基本面 并行，情绪+基金 并行）
  console.log('  🧠 Step 2: 四维度分析...');
  console.log('  📊 分析中: 技术面 & 基本面...');
  const [technical, fundamental] = await Promise.all([
    new TechnicalAgent().analyze(marketData),
    new FundamentalAgent().analyze(marketData),
  ]);
  console.log(`  ✅ 技术面 ${technical.score}/100 | 基本面 ${fundamental.score}/100`);

  console.log('  📊 分析中: 情绪面 & 基金面...');
  const [sentiment, fund] = await Promise.all([
    new SentimentAgent().analyze(marketData),
    new FundAgent().analyze(marketData),
  ]);
  console.log(`  ✅ 情绪面 ${sentiment.score}/100 | 基金面 ${fund.valuation.level}`);

  // Step 2.5: 强制反驳
  console.log('  ⚔️ Step 2.5: 强制反驳...');
  const rebuttalAgent = new RebuttalAgent();
  const rebuttal = await rebuttalAgent.rebut(technical, fundamental, sentiment, fund, marketData);
  let scoreBreakdown = buildScoreBreakdown(technical, fundamental, sentiment, rebuttal);
  console.log(`  ✅ 反驳完成 (看空力度: ${rebuttal.bearScore}/100, 强度: ${rebuttal.rebuttalStrength})`);
  console.log(`  📈 ${formatScoreBreakdownOneLine(scoreBreakdown)}`);
  console.log(formatScoreBreakdownConsole(scoreBreakdown));

  let goldDeviation: number | null = null;
  try {
    const closes = forwardFillCloses(priceRepo.getRecent(60));
    goldDeviation = latestDeviationFromMA(closes, 20);
  } catch { /* ignore */ }

  const macroRegime = detectMacroRegime(marketData, goldDeviation);
  const causalChains = matchCausalChains(marketData, macroRegime, goldDeviation);
  console.log(formatCausalChainsConsole(causalChains));

  const db = getDb();
  const reportsRepo = new ReportsRepo(db);
  const today = todayDate();
  const recentReportsContext = buildRecentReportsContext(reportsRepo.getRecent(30), today);

  const prelimScore = resolveOverallScore(rebuttal, {
    technical: technical.score,
    fundamental: fundamental.score,
    sentiment: sentiment.score,
  });
  const prelimDirection = directionFromScore(prelimScore);

  let scenarioProbs = computeScenarioProbabilities([]);
  let preSimilar: PatternMatch[] = [];
  try {
    const featRepo = new ScenarioFeaturesRepo(db);
    const consecutiveDays = countConsecutiveDirectionDays(
      reportsRepo.getRecent(30).map(r => ({ date: r.date, direction: r.direction })),
      prelimDirection,
      today,
    );
    const draft = buildScenarioFeatureDraft(
      {
        timestamp: new Date().toISOString(),
        marketData,
        technical,
        fundamental,
        sentiment,
        overall: { direction: prelimDirection },
      },
      goldDeviation ?? 0,
      consecutiveDays,
    );
    const history = featRepo.listForSimilarity(200);
    const scoreMap = new Map(reportsRepo.getRecent(365).map(r => [r.id, { score: r.overallScore, direction: r.direction }]));
    preSimilar = findSimilarPatterns(draftToScenarioFeature(draft), history, scoreMap, {
      excludeDate: today,
      topK: 8,
      filledOnly: true,
    });
    scenarioProbs = computeScenarioProbabilities(preSimilar);
    if (scenarioProbs.source === 'historical') {
      console.log(`  📊 ${scenarioProbs.note}`);
    }
  } catch { /* ignore */ }

  const orchestrateOpts: OrchestrateOptions = {
    macroRegime,
    recentReportsContext,
    scenarioProbs,
    causalChains,
  };

  // Step 3: 综合编排
  console.log('  🎯 Step 3: 综合编排...');
  const orchestrator = new OrchestratorAgent();
  const report = await orchestrator.orchestrate(
    marketData,
    technical,
    fundamental,
    sentiment,
    fund,
    rebuttal,
    options.horizon,
    orchestrateOpts,
  );
  scoreBreakdown = extendBreakdownWithCalibration(
    scoreBreakdown,
    report.overall.calibration,
    report.overall.score,
  );
  report.dataQuality = {
    overallConfidence: validation.overallConfidence,
    warnings: priceWarnings,
  };
  console.log('  ✅ 编排完成');

  const judgeVerdict = buildJudgeVerdict(technical, fundamental, sentiment, rebuttal, scoreBreakdown);
  console.log(formatJudgeVerdictConsole(judgeVerdict));

  console.log(`  🌐 宏观阶段: ${formatMacroRegimeLine(macroRegime)}`);

  const priceHistory = priceRepo.getRecent(800);
  const longTermOutlook = buildLongTermOutlook({
    technical: report.technical,
    fundamental: report.fundamental,
    sentiment: report.sentiment,
    rebuttal: report.rebuttal,
    overallScore: report.overall.score,
    overallDirection: report.overall.direction,
    macroRegime,
    priceHistory,
  });
  report.longTermOutlook = longTermOutlook;
  report.macroRegime = macroRegime;
  report.causalChains = causalChains;

  let similarPatterns: PatternMatch[] = preSimilar;
  if (similarPatterns.length > 0) {
    console.log('  📜 历史相似日（已回填 5 日收益）:');
    for (const p of similarPatterns.slice(0, 3)) {
      const ret = p.actual5dReturn != null ? `${p.actual5dReturn > 0 ? '+' : ''}${p.actual5dReturn.toFixed(2)}%` : 'N/A';
      console.log(`     ${p.date} 相似度 ${(p.similarity * 100).toFixed(0)}% → 5日后 ${ret}（当时 ${p.score} 分）`);
    }
  } else {
    console.log('  📜 历史相似日: 样本不足（需更多已回填的 scenario_features）');
  }

  const manifest = buildRunManifest({
    horizon: options.horizon,
    startedAt,
    report,
    scoreBreakdown,
    macroRegime,
    judgeVerdict,
    similarPatterns,
    longTermOutlook: report.longTermOutlook,
  });
  const manifestPath = saveRunManifest(manifest);
  console.log(`  📦 审计包已保存: ${manifestPath}`);

  const reportExtras = { macroRegime, judgeVerdict, similarPatterns, scoreBreakdown, longTermOutlook };

  // 输出报告
  if (options.json) {
    if (options.jsonLegacy) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(JSON.stringify(wrapAnalysisOutputV1(manifest, report), null, 2));
    }
  } else {
    printReport(report, options.horizon, scoreBreakdown, reportExtras);
  }

  // 保存到文件 (JSON schema v1)
  if (options.save) {
    const filename = `goldrush-analysis-${new Date().toISOString().slice(0, 10)}.json`;
    const fs = await import('node:fs');
    fs.writeFileSync(filename, JSON.stringify(wrapAnalysisOutputV1(manifest, report), null, 2), 'utf-8');
    console.log(`\n💾 报告已保存到 ${filename}（schema v1）`);
  }

  // 保存为 Markdown 格式
  if (options.md) {
    const fs = await import('node:fs');
    const docsDir = 'docs';
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
    const filename = `${docsDir}/goldrush-analysis-${new Date().toISOString().slice(0, 10)}.md`;
    const mdContent = formatReportMarkdown(report, options.horizon, reportExtras);
    fs.writeFileSync(filename, mdContent, 'utf-8');
    console.log(`\n📝 报告已保存为 Markdown: ${filename}`);
  }

  // 清理
  await collector.cleanup();
  await validator.cleanup();
  await rebuttalAgent.cleanup();
  await orchestrator.cleanup();
  return 0;
}

/** Smart 平稳日：复用上一报告，返回 null 表示需转完整分析 */
async function runSmartAnalysis(
  options: {
    horizon: Horizon;
    json: boolean;
    jsonLegacy: boolean;
    save: boolean;
    md: boolean;
  },
  gate: import('../utils/analysis-gate.js').AnalysisGateResult,
  priceRepo: GoldPricesRepo,
  startedAt: string,
): Promise<number | null> {
  const db = getDb();
  const reportsRepo = new ReportsRepo(db);
  const today = todayDate();
  const prevRow = reportsRepo.getRecent(14).find(r => r.date < today);
  if (!prevRow) return null;

  const previous = parseReportJson(prevRow.reportJson);
  if (!previous) return null;

  let goldDeviation: number | null = null;
  try {
    goldDeviation = latestDeviationFromMA(forwardFillCloses(priceRepo.getRecent(60)), 20);
  } catch { /* ignore */ }

  const macroRegime = detectMacroRegime(previous.marketData, goldDeviation);
  const report = buildSmartReport(previous, macroRegime, gate, prevRow.date);
  report.macroRegime = macroRegime;

  const scoreBreakdown = buildScoreBreakdown(
    report.technical,
    report.fundamental,
    report.sentiment,
    report.rebuttal,
  );
  const judgeVerdict = buildJudgeVerdict(
    report.technical,
    report.fundamental,
    report.sentiment,
    report.rebuttal,
    scoreBreakdown,
  );

  reportsRepo.insert({
    date: today,
    horizon: options.horizon,
    reportJson: JSON.stringify(report),
    overallScore: report.overall.score,
    direction: report.overall.direction,
  });

  const manifest = buildRunManifest({
    horizon: options.horizon,
    startedAt,
    report,
    scoreBreakdown,
    macroRegime,
    judgeVerdict,
    similarPatterns: [],
    longTermOutlook: report.longTermOutlook,
  });

  console.log('  ✅ Smart 简版报告已生成（零 LLM）');

  if (options.json) {
    console.log(JSON.stringify(wrapAnalysisOutputV1(manifest, report), null, 2));
  } else {
    printReport(report, options.horizon, scoreBreakdown, { macroRegime });
  }

  if (options.save) {
    const fs = await import('node:fs');
    const filename = `goldrush-analysis-${today}.json`;
    fs.writeFileSync(filename, JSON.stringify(wrapAnalysisOutputV1(manifest, report), null, 2), 'utf-8');
    console.log(`\n💾 报告已保存到 ${filename}`);
  }

  if (options.md) {
    const fs = await import('node:fs');
    const docsDir = 'docs';
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
    const filename = `${docsDir}/goldrush-analysis-${today}.md`;
    fs.writeFileSync(filename, formatReportMarkdown(report, options.horizon, { macroRegime, scoreBreakdown }), 'utf-8');
    console.log(`\n📝 报告已保存为 Markdown: ${filename}`);
  }

  return 0;
}

function printReport(
  report: GoldAnalysisReport,
  horizon: Horizon,
  scoreBreakdown?: ReturnType<typeof buildScoreBreakdown>,
  extras?: {
    macroRegime?: import('../utils/macro-regime.js').MacroRegime;
    judgeVerdict?: import('../utils/judge-verdict.js').JudgeVerdict;
    similarPatterns?: PatternMatch[];
    longTermOutlook?: import('../types/analysis.js').LongTermOutlook;
  },
): void {
  const { overall, technical, fundamental, sentiment, fund: fundAnalysis, rebuttal, tailRisks } = report;

  console.log(header('🎯 GoldRush 综合分析报告', formatNow()));

  const bd = scoreBreakdown ?? buildScoreBreakdown(technical, fundamental, sentiment, rebuttal);
  console.log('\n' + formatScoreBreakdownConsole(bd, '  '));

  if (extras?.macroRegime) {
    console.log(`\n  🌐 宏观阶段: ${formatMacroRegimeLine(extras.macroRegime)}`);
  }
  if (report.causalChains?.length) {
    console.log('\n' + formatCausalChainsConsole(report.causalChains, '  '));
  }
  if (extras?.judgeVerdict) {
    console.log('\n' + formatJudgeVerdictConsole(extras.judgeVerdict, '  '));
  }
  if (extras?.similarPatterns && extras.similarPatterns.length > 0) {
    console.log(`\n  📜 历史相似日（Top ${Math.min(3, extras.similarPatterns.length)}）`);
    for (const p of extras.similarPatterns.slice(0, 3)) {
      const ret = p.actual5dReturn != null ? `${p.actual5dReturn > 0 ? '+' : ''}${p.actual5dReturn.toFixed(2)}%` : '待回填';
      console.log(`  · ${p.date} 相似 ${(p.similarity * 100).toFixed(0)}% | 5日后 ${ret} | 当时评分 ${p.score}`);
    }
  }

  if (extras?.longTermOutlook) {
    console.log('\n' + formatLongTermOutlookConsole(extras.longTermOutlook));
  }

  // 综合研判
  const scoreDisplay = overall?.score ?? 'N/A';
  const directionDisplay = overall?.direction ?? 'neutral';
  console.log(`\n  综合研判: ${directionMark(directionDisplay)} ${scoreDisplay}/100`);
  if (overall?.score) {
    console.log(`  ${scoreBar(overall.score)}`);
  }

  // 校准上下文
  if (overall?.calibration?.historicalAccuracy != null) {
    const cal = overall.calibration;
    const pct5 = Math.round(cal.historicalAccuracy! * 100);
    const pct20 = cal.historicalAccuracy20d != null ? Math.round(cal.historicalAccuracy20d * 100) : null;
    const t20 = pct20 != null ? `，20日${pct20}%` : '';
    console.log(`  📊 校准参考: ${cal.scoreRange}区间 5日涨概率${pct5}%${t20} (${cal.systematicBias})`);
    if (cal.calibrationApplied && cal.calibrationOffset != null && cal.calibrationOffset !== 0) {
      console.log(`  📐 数值校准: 反驳后${cal.rawScore}分 → 偏移${cal.calibrationOffset > 0 ? '+' : ''}${cal.calibrationOffset} → 展示${overall.score}分`);
    }
  }

  // 情景分析
  console.log(`\n  ⚡ 情景分析`);
  const scenarios = overall?.scenarios;
  if (scenarios) {
    const { base, upside, downside } = scenarios;
    console.log(`  基准 (${base.probability}%): ${base.description} → ${base.action}`);
    console.log(`  上行 (${upside.probability}%): ${upside.description} (触发: ${upside.trigger})`);
    console.log(`  下行 (${downside.probability}%): ${downside.description} (触发: ${downside.trigger})`);
  } else {
    console.log(`  (情景数据暂不可用)`);
  };

  // 四维度摘要
  console.log(`\n  📈 四维度摘要`);
  console.log(`  技术面: ${technical.score}/100 ${directionMark(technical.direction)} — ${technical.summary}`);
  console.log(`  基本面: ${fundamental.score}/100 ${directionMark(fundamental.direction)} — ${fundamental.summary}`);
  console.log(`  情绪面: ${sentiment.score}/100 ${directionMark(sentiment.direction)} — ${sentiment.summary}`);
  console.log(`  基金面: 估值${valuationMark(fundAnalysis.valuation.level)}`);

  // 反驳摘要
  console.log(`\n  🔴 强制反驳摘要`);
  console.log(`  反驳强度: ${rebuttal.rebuttalStrength} | 看空力度: ${rebuttal.bearScore}/100`);
  for (const point of (rebuttal.bearPoints ?? []).slice(0, 3)) {
    console.log(`  · ${point.point} (${point.probability}%概率)`);
  }
  for (const vul of (rebuttal.bullVulnerabilities ?? []).slice(0, 2)) {
    console.log(`  · 看多漏洞: ${vul.vulnerability}`);
  }
  if (rebuttal.adjustedScore) {
    console.log(`  → 详见上方「评分构成」明细`);
  }

  // 双轨策略
  if (horizon !== 'mid' && overall?.shortTerm) {
    console.log(`\n  ⏱️ 短期策略 (日线级别)`);
    console.log(`  操作: ${overall.shortTerm.action ?? 'N/A'}`);
    console.log(`  入场: ${overall.shortTerm.entryZone ?? 'N/A'}`);
    console.log(`  目标: ${overall.shortTerm.target ?? 'N/A'}`);
    console.log(`  止损: ${overall.shortTerm.stopLoss ?? 'N/A'}`);
    console.log(`  品种: ${overall.shortTerm.recommendedProduct ?? 'N/A'}`);
    console.log(`  ⚠️ ${overall.shortTerm.riskWarning ?? 'N/A'}`);
  }

  if (horizon !== 'short' && overall?.midTerm) {
    console.log(`\n  📅 中长期策略 (周线级别)`);
    const mid = overall.midTerm;
    console.log(`  定投: ${mid.investAdvice?.dipInvest === 'increase' ? '加码' : mid.investAdvice?.dipInvest === 'pause' ? '暂停' : '继续'}`);
    console.log(`  仓位: ${mid.investAdvice?.positionAdjust === 'add' ? '加仓' : mid.investAdvice?.positionAdjust === 'reduce' ? '减仓' : '维持'}`);
    console.log(`  推荐基金: ${mid.investAdvice?.recommendedFund ?? 'N/A'}`);
    console.log(`  支撑区: ${mid.keyLevels?.supportZone ?? 'N/A'}`);
    console.log(`  阻力区: ${mid.keyLevels?.resistanceZone ?? 'N/A'}`);
    console.log(`  ⚠️ ${mid.riskWarning ?? 'N/A'}`);
  }

  // 尾部风险
  const tailRiskList = tailRisks ?? [];
  if (tailRiskList.length > 0) {
    console.log(`\n  ⚠️ 尾部风险`);
    for (const risk of tailRiskList) {
      console.log(`  ${risk.probability}% → ${risk.risk}: ${risk.impact} (触发: ${risk.trigger})`);
      console.log(`    对冲: ${risk.mitigation}`);
    }

    // 尾部风险指数（互斥修正，避免虚高）
    const maxCap = getConfig().investment.maxTailRiskIndex * 2.5;
    const { index, rawUnion } = computeTailRiskIndex(tailRiskList, maxCap);
    console.log(`  综合尾部风险指数: ${index.toFixed(1)}%`);
    if (rawUnion - index > 5) {
      console.log(`  （朴素并概率 ${rawUnion.toFixed(1)}%，已做互斥修正）`);
    }
  }

  console.log(separator('═', 55));
}

/** 渲染报告为 Markdown 格式 */
// 委托 report-md.ts 中的规范渲染函数，消除重复实现
const renderReportMarkdown = formatReportMarkdown;
