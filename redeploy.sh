#!/bin/bash
# Redeploy topic-router plugin to container.
# Run from: /root/.openclaw/workspace/code-repo/openclaw-topic-router
set -e

SRC="dist/src"
DST="/app/dist/extensions/topic-router/src"

git pull

cp "$SRC/hook-handler.js" "$DST/hook-handler.js"
cp "$SRC/classifier.js" "$DST/classifier.js"
cp "$SRC/commands.js" "$DST/commands.js"
cp "$SRC/topic-registry.js" "$DST/topic-registry.js"
cp "$SRC/utils.js" "$DST/utils.js"
cp dist/index.js /app/dist/extensions/topic-router/index.js

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
