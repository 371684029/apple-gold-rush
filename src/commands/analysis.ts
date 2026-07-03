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
import { buildScoreBreakdown, formatScoreBreakdownConsole, formatScoreBreakdownOneLine } from '../utils/score-breakdown.js';
import { detectMacroRegime, formatMacroRegimeLine } from '../utils/macro-regime.js';
import { buildJudgeVerdict, formatJudgeVerdictConsole } from '../utils/judge-verdict.js';
import { findSimilarPatterns } from '../utils/scenario-similarity.js';
import { buildRunManifest, saveRunManifest, wrapAnalysisOutputV1 } from '../utils/run-manifest.js';
import { getDb } from '../db/index.js';
import { ScenarioFeaturesRepo } from '../db/scenario-features.js';
import { ReportsRepo } from '../db/reports.js';
import { forwardFillCloses, latestDeviationFromMA } from '../utils/price-series.js';
import { GoldPricesRepo } from '../db/gold-prices.js';
import { formatNow } from '../utils/time.js';
import type { Horizon } from '../types/config.js';
import type { GoldAnalysisReport } from '../types/analysis.js';
import type { PatternMatch } from '../types/calibration.js';

export async function analysisCommand(options: {
  horizon: Horizon;
  json: boolean;
  jsonLegacy: boolean;
  save: boolean;
  md: boolean;
}): Promise<number> {
  const startedAt = new Date().toISOString();
  console.log('\n🔬 GoldRush 综合分析启动...\n');

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
  const scoreBreakdown = buildScoreBreakdown(technical, fundamental, sentiment, rebuttal);
  console.log(`  ✅ 反驳完成 (看空力度: ${rebuttal.bearScore}/100, 强度: ${rebuttal.rebuttalStrength})`);
  console.log(`  📈 ${formatScoreBreakdownOneLine(scoreBreakdown)}`);
  console.log(formatScoreBreakdownConsole(scoreBreakdown));

  // Step 3: 综合编排
  console.log('  🎯 Step 3: 综合编排...');
  const orchestrator = new OrchestratorAgent();
  const report = await orchestrator.orchestrate(marketData, technical, fundamental, sentiment, fund, rebuttal, options.horizon);
  report.dataQuality = {
    overallConfidence: validation.overallConfidence,
    warnings: validation.warnings,
  };
  console.log('  ✅ 编排完成');

  const judgeVerdict = buildJudgeVerdict(technical, fundamental, sentiment, rebuttal, scoreBreakdown);
  console.log(formatJudgeVerdictConsole(judgeVerdict));

  let goldDeviation: number | null = null;
  try {
    const closes = forwardFillCloses(new GoldPricesRepo(getDb()).getRecent(60));
    goldDeviation = latestDeviationFromMA(closes, 20);
  } catch { /* ignore */ }

  const macroRegime = detectMacroRegime(marketData, goldDeviation);
  console.log(`  🌐 宏观阶段: ${formatMacroRegimeLine(macroRegime)}`);

  let similarPatterns: PatternMatch[] = [];
  try {
    const db = getDb();
    const featRepo = new ScenarioFeaturesRepo(db);
    const reportDate = report.timestamp.slice(0, 10);
    const currentFeat = featRepo.getByDate(reportDate);
    if (currentFeat) {
      const history = featRepo.listForSimilarity(200);
      const recentReports = new ReportsRepo(db).getRecent(365);
      const scoreMap = new Map(recentReports.map(r => [r.id, { score: r.overallScore, direction: r.direction }]));
      similarPatterns = findSimilarPatterns(currentFeat, history, scoreMap, {
        excludeDate: reportDate,
        topK: 5,
        filledOnly: true,
      });
      if (similarPatterns.length > 0) {
        console.log('  📜 历史相似日（已回填 5 日收益）:');
        for (const p of similarPatterns.slice(0, 3)) {
          const ret = p.actual5dReturn != null ? `${p.actual5dReturn > 0 ? '+' : ''}${p.actual5dReturn.toFixed(2)}%` : 'N/A';
          console.log(`     ${p.date} 相似度 ${(p.similarity * 100).toFixed(0)}% → 5日后 ${ret}（当时 ${p.score} 分）`);
        }
      } else {
        console.log('  📜 历史相似日: 样本不足（需更多已回填的 scenario_features）');
      }
    }
  } catch { /* ignore */ }

  const manifest = buildRunManifest({
    horizon: options.horizon,
    startedAt,
    report,
    scoreBreakdown,
    macroRegime,
    judgeVerdict,
    similarPatterns,
  });
  const manifestPath = saveRunManifest(manifest);
  console.log(`  📦 审计包已保存: ${manifestPath}`);

  const reportExtras = { macroRegime, judgeVerdict, similarPatterns, scoreBreakdown };

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

function printReport(
  report: GoldAnalysisReport,
  horizon: Horizon,
  scoreBreakdown?: ReturnType<typeof buildScoreBreakdown>,
  extras?: {
    macroRegime?: import('../utils/macro-regime.js').MacroRegime;
    judgeVerdict?: import('../utils/judge-verdict.js').JudgeVerdict;
    similarPatterns?: PatternMatch[];
  },
): void {
  const { overall, technical, fundamental, sentiment, fund: fundAnalysis, rebuttal, tailRisks } = report;

  console.log(header('🎯 GoldRush 综合分析报告', formatNow()));

  const bd = scoreBreakdown ?? buildScoreBreakdown(technical, fundamental, sentiment, rebuttal);
  console.log('\n' + formatScoreBreakdownConsole(bd, '  '));

  if (extras?.macroRegime) {
    console.log(`\n  🌐 宏观阶段: ${formatMacroRegimeLine(extras.macroRegime)}`);
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

  // 综合研判
  const scoreDisplay = overall?.score ?? 'N/A';
  const directionDisplay = overall?.direction ?? 'neutral';
  console.log(`\n  综合研判: ${directionMark(directionDisplay)} ${scoreDisplay}/100`);
  if (overall?.score) {
    console.log(`  ${scoreBar(overall.score)}`);
  }

  // 校准上下文
  if (overall?.calibration?.historicalAccuracy !== null && overall?.calibration?.historicalAccuracy !== undefined) {
    console.log(`  📊 校准参考: ${overall.calibration.scoreRange}区间历史准确率${Math.round(overall.calibration.historicalAccuracy * 100)}% (${overall.calibration.systematicBias})`);
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
