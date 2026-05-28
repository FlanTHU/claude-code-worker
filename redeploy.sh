#!/bin/bash
# Redeploy topic-router plugin to container.
# Run from: /root/.openclaw/workspace/code-repo/openclaw-topic-router
set -e

DST="/app/dist/extensions/topic-router/src"
BRANCH="v2-direct-llm"

git fetch origin "$BRANCH"
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"

# Use git show to avoid sparse-checkout / working-tree issues
git show HEAD:dist/src/hook-handler.js > "$DST/hook-handler.js"
git show HEAD:dist/src/classifier.js > "$DST/classifier.js"
git show HEAD:dist/src/commands.js > "$DST/commands.js"
git show HEAD:dist/src/topic-registry.js > "$DST/topic-registry.js"
git show HEAD:dist/src/llm-client.js > "$DST/llm-client.js"
git show HEAD:dist/src/utils.js > "$DST/utils.js"
git show HEAD:dist/src/types.js > "$DST/types.js" 2>/dev/null || true
git show HEAD:dist/index.js > /app/dist/extensions/topic-router/index.js

pkill -9 -f "openclaw" || true
sleep 2
runuser -u node -- /tmp/sg.sh &>/tmp/gw.log &

sleep 5
if pgrep -f "openclaw gateway" >/dev/null; then
  echo "OK: gateway running"
else
  echo "FAIL: gateway not started"
  tail -5 /tmp/gw.log
  exit 1
fi
