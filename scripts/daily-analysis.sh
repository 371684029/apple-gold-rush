#!/usr/bin/env bash
# GoldRush 每日分析 — 每天 11:30 由 cron 触发
# 生成 Markdown 报告到 docs/ 目录

set -e

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

# 日志
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/daily-$(date +%Y-%m-%d).log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] GoldRush 每日分析开始" >> "$LOG_FILE" 2>&1

# 拉取最新代码，有变更才构建；网络失败不阻断分析
BEFORE=$(git rev-parse HEAD)
git pull >> "$LOG_FILE" 2>&1 || true
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" != "$AFTER" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 检测到新代码，重新构建..." >> "$LOG_FILE" 2>&1
  npm run build >> "$LOG_FILE" 2>&1
fi

# 运行分析
node "$PROJECT_DIR/dist/index.js" analysis --md >> "$LOG_FILE" 2>&1

EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ 分析完成" >> "$LOG_FILE" 2>&1
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ 分析失败 (exit code: $EXIT_CODE)" >> "$LOG_FILE" 2>&1
fi

exit $EXIT_CODE
