// 工具函数统一导出
export { getTradingTime, formatNow, todayDate } from './time.js';
export {
  separator, header, gradeMark, changeColor,
  directionMark, scoreBar, priceTable, formatPrice,
  riskLevel, valuationMark, sessionMark,
} from './format.js';
export { loadConfig, getConfig, saveConfig } from './config.js';
export {
  gradeSource,
  crossValidate,
  checkFreshness,
  singleSourceConfidence,
  weightedFieldConfidence,
} from './source-rank.js';
export {
  evaluateDataQualityGate,
  formatDataQualityGateConsole,
  formatDataQualityGateMarkdown,
  nonActionableAdvice,
} from './data-quality-gate.js';
export {
  evaluateDualScore,
  formatDualScoreConsole,
  formatDualScoreMarkdown,
  buildDualConflictOverride,
  alignDualOverrideWithPosition,
  DUAL_CONFLICT_THRESHOLD,
} from './dual-score.js';
export {
  recommendPosition,
  formatPositionConsole,
  formatPositionMarkdown,
  computePriceRiskMetrics,
  volToScalar,
  drawdownToScalar,
  smoothTargetPct,
  extractPreviousTargetPct,
  POSITION_MAX_DAILY_DELTA,
} from './position-recommend.js';
export {
  buildPredictionTrackStats,
  savePredictionTrackJson,
  formatPredictionTrackConsole,
  formatPredictionTrackMarkdown,
} from './prediction-track.js';
export {
  buildReliabilityCard,
  formatReliabilityConsole,
  formatReliabilityMarkdown,
} from './reliability-card.js';
export {
  archiveSearchRaw,
  toArchiveEntries,
} from './search-raw-archive.js';
export {
  scoreToAdvice,
  checkConsistency,
  consistencyEmoji,
  resolveOperationalAdvice,
} from './plain-advice.js';
export {
  buildReportMeta,
  saveReportMeta,
  loadReportMeta,
  metaPathForMarkdown,
  REPORT_META_SCHEMA,
} from './report-meta.js';
export type {
  ReportMeta,
  ReportMetaHorizon,
  BuildReportMetaInput,
} from './report-meta.js';
