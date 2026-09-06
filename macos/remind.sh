#!/usr/bin/env bash
# 每日学习提醒入口（由 launchd 定时调用）。
# 读 profile，算今天到期复习数，弹原生通知；点击横幅后唤起 Terminal + pi。
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
APP="$DIR/notifier/CoachNotifier.app"
PROFILE="$ROOT/.pi/state/profile.json"

# node 探测：优先 PATH，其次 nvm 默认路径
NODE="$(command -v node || true)"
if [ -z "$NODE" ] && [ -x "$HOME/.nvm/versions/node/v22.22.1/bin/node" ]; then
  NODE="$HOME/.nvm/versions/node/v22.22.1/bin/node"
fi

[ -n "$NODE" ] || exit 0
[ -f "$PROFILE" ] || exit 0

INIT="$("$NODE" -e "console.log(require('$PROFILE').initialized ? 'yes' : 'no')" 2>/dev/null || echo no)"
if [ "$INIT" != "yes" ]; then
  # 未初始化不提醒
  exit 0
fi

DUE="$("$NODE" -e "
const p = require('$PROFILE');
const now = Date.now();
const due = Object.values(p.knowledge || {}).filter(k => !k.catalogMissing && k.nextReview && new Date(k.nextReview) <= now);
const names = due.slice(0, 3).map(k => k.name);
console.log(names.length ? names.join('、') : '');
" 2>/dev/null || true)"

PLAN_DUE="$("$NODE" -e "
const p = require('$PROFILE');
console.log(p.plan?.nextReviewAt && new Date(p.plan.nextReviewAt) <= Date.now() ? 'yes' : 'no');
" 2>/dev/null || echo no)"

if [ -n "$DUE" ]; then
  TITLE="学习提醒"
  BODY="今天到期复习：$DUE"
  if [ "$PLAN_DUE" = "yes" ]; then BODY="$BODY；学习计划也需复盘"; fi
elif [ "$PLAN_DUE" = "yes" ]; then
  TITLE="计划复盘"
  BODY="今天先复盘学习计划，再安排新内容"
else
  TITLE="学习时间"
  BODY="今天没有到期复习，按当前主攻学习"
fi

# 杀掉可能残留的旧 notifier 实例，避免堆积
pkill -f "CoachNotifier" 2>/dev/null || true
sleep 1

open "$APP" --args --title "$TITLE" --body "$BODY" --command "cd $ROOT && pi"