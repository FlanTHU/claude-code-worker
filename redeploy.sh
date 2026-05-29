#!/bin/bash
# Redeploy topic-router plugin to container.
# Run from: /root/.openclaw/workspace/code-repo/openclaw-topic-router
set -e

DST="/app/dist/extensions/topic-router/src"
BRANCH="v2-direct-llm"

echo "=== Step 1: Fetch latest code ==="
git fetch origin "$BRANCH" --force
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"
echo "HEAD is now: $(git log --oneline -1)"

echo ""
echo "=== Step 2: Copy dist files ==="
git show HEAD:dist/src/hook-handler.js > "$DST/hook-handler.js"
git show HEAD:dist/src/classifier.js > "$DST/classifier.js"
git show HEAD:dist/src/commands.js > "$DST/commands.js"
git show HEAD:dist/src/topic-registry.js > "$DST/topic-registry.js"
git show HEAD:dist/src/llm-client.js > "$DST/llm-client.js"
git show HEAD:dist/src/utils.js > "$DST/utils.js"
git show HEAD:dist/src/types.js > "$DST/types.js" 2>/dev/null || true
git show HEAD:dist/index.js > /app/dist/extensions/topic-router/index.js
echo "Files copied."

echo ""
echo "=== Step 3: Verify deployment ==="
if grep -q "KEYWORD_MATURITY" "$DST/classifier.js"; then
  echo "  ✓ classifier.js — zero-overlap rule present"
else
  echo "  ✗ classifier.js — MISSING zero-overlap rule!"
fi
if grep -q 'keywords = \[\]' "$DST/commands.js"; then
  echo "  ✓ commands.js — /new resets keywords"
else
  echo "  ✗ commands.js — MISSING keyword reset!"
fi
if grep -q "mimo-v2.5-mit" /app/dist/extensions/topic-router/index.js; then
  echo "  ✓ index.js — using mimo-v2.5-mit"
else
  echo "  ✗ index.js — wrong model!"
fi

echo ""
echo "=== Step 4: Restart gateway ==="
pkill -9 -f "openclaw" 2>/dev/null || true
sleep 2
runuser -u node -- /tmp/sg.sh &>/tmp/gw.log &
disown

echo "Waiting for gateway..."
for i in $(seq 1 20); do
  sleep 2
  if grep -q "http server listening" /tmp/gw.log 2>/dev/null; then
    echo "✓ Gateway started (${i}x2s)"
    echo ""
    echo "=== Step 5: Confirm plugin loaded ==="
    grep "topic-router" /tmp/gw.log | tail -5
    echo ""
    echo "=== Deploy complete ==="
    exit 0
  fi
done
echo "✗ Gateway not ready after 40s. Last 15 lines:"
tail -15 /tmp/gw.log
exit 1
