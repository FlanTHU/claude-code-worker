#!/bin/bash
# Redeploy topic-router plugin to container.
# Usage: bash redeploy.sh (from any directory)
set -e

REPO_DIR="/root/.openclaw/workspace/code-repo/openclaw-topic-router"
DST="/app/dist/extensions/topic-router/src"
BRANCH="main"

cd "$REPO_DIR"

echo "=== Step 1: Fetch latest code ==="
git fetch origin "$BRANCH" --force
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"
echo "HEAD: $(git log --oneline -1)"

# Self-update: if the script on disk differs from HEAD, re-exec the latest version
SELF="$REPO_DIR/redeploy.sh"
if ! git diff --quiet HEAD -- redeploy.sh 2>/dev/null; then
  echo "(redeploy.sh updated, re-executing...)"
  exec bash "$SELF"
fi

echo ""
echo "=== Step 2: Copy dist files ==="
git show HEAD:dist/src/hook-handler.js > "$DST/hook-handler.js"
git show HEAD:dist/src/classifier.js > "$DST/classifier.js"
git show HEAD:dist/src/commands.js > "$DST/commands.js"
git show HEAD:dist/src/topic-registry.js > "$DST/topic-registry.js"
git show HEAD:dist/src/llm-client.js > "$DST/llm-client.js"
git show HEAD:dist/src/utils.js > "$DST/utils.js"
git show HEAD:dist/src/types.js > "$DST/types.js" 2>/dev/null || true
git show HEAD:dist/src/conversation-store.js > "$DST/conversation-store.js" 2>/dev/null || true
git show HEAD:dist/src/feedback-store.js > "$DST/feedback-store.js" 2>/dev/null || true
git show HEAD:dist/src/context-bridge.js > "$DST/context-bridge.js" 2>/dev/null || true
git show HEAD:dist/index.js > /app/dist/extensions/topic-router/index.js
echo "Files copied."

echo ""
echo "=== Step 2.5: Ensure writable state dirs ==="
STATE_DIR="/root/.openclaw/topic-router-state"
mkdir -p "$STATE_DIR" /root/.openclaw/devices /root/.openclaw/logs/traces
# Allow node user to traverse /root and reach state dirs
chmod o+x /root /root/.openclaw
chmod 777 "$STATE_DIR" /root/.openclaw/devices /root/.openclaw/logs /root/.openclaw/logs/traces
# Ensure existing files are writable by node user
find "$STATE_DIR" /root/.openclaw/devices /root/.openclaw/logs -maxdepth 1 -type f -exec chmod 666 {} \; 2>/dev/null || true
echo "State dirs ready."

echo ""
echo "=== Step 3: Verify deployment ==="
PASS=true
check() {
  if grep -q "$2" "$3" 2>/dev/null; then
    echo "  ✓ $1"
  else
    echo "  ✗ $1"
    PASS=false
  fi
}
check "classifier — zero-overlap rule" "KEYWORD_MATURITY" "$DST/classifier.js"
check "commands — /new resets keywords" 'keywords = \[\]' "$DST/commands.js"
check "index — mimo-v2.5-mit model" "mimo-v2.5-mit" "/app/dist/extensions/topic-router/index.js"
check "hook-handler — session routing" "sessionKey" "$DST/hook-handler.js"
check "v4 — feedback-store" "adaptThresholds" "$DST/feedback-store.js"
check "v4 — context-bridge" "checkMerge" "$DST/context-bridge.js"

if [ "$PASS" = false ]; then
  echo ""
  echo "⚠️  Some checks failed. Continuing with restart anyway..."
fi

echo ""
echo "=== Step 4: Restart gateway ==="
# Kill all openclaw processes (the binary is just "openclaw", not "openclaw gateway")
kill -9 $(pgrep -x openclaw) 2>/dev/null || true
sleep 3
: > /tmp/gw.log
GW_SCRIPT="${GW_SCRIPT:-/root/.openclaw/sg.sh}"
[ -f "$GW_SCRIPT" ] || GW_SCRIPT="/tmp/sg.sh"
if command -v runuser &>/dev/null && id node &>/dev/null 2>&1; then
  runuser -u node -- "$GW_SCRIPT" &>/tmp/gw.log &
else
  "$GW_SCRIPT" &>/tmp/gw.log &
fi
disown

echo "Waiting for gateway..."
for i in $(seq 1 30); do
  sleep 2
  if grep -q "http server listening" /tmp/gw.log 2>/dev/null; then
    echo "✓ Gateway started (${i}x2s)"
    echo ""
    echo "=== Step 5: Confirm plugin loaded ==="
    grep "topic-router" /tmp/gw.log | head -5
    echo ""
    if grep -q "topic-router" /tmp/gw.log; then
      echo "=== ✓ Deploy complete ==="
    else
      echo "=== ⚠️ Gateway started but topic-router not loaded! ==="
      exit 1
    fi
    exit 0
  fi
done
echo "✗ Gateway not ready after 60s. Last 20 lines:"
tail -20 /tmp/gw.log
exit 1
