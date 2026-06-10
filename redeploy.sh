#!/bin/bash
# Redeploy topic-router plugin to container.
# Usage: bash redeploy.sh (from any directory)
set -e

# Auto-detect repo dir: use script's own location
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST="/app/dist/extensions/topic-router/src"
BRANCH="main"

cd "$REPO_DIR"
git config --global --add safe.directory "$REPO_DIR"

echo "=== Step 1: Fetch latest code ==="
SELF="$REPO_DIR/redeploy.sh"
OLD_HASH=$(md5sum "$SELF" 2>/dev/null | cut -d' ' -f1)
git config --global http.lowSpeedLimit 1000
git config --global http.lowSpeedTime 10
for attempt in 1 2 3; do
  timeout 30 git fetch origin "$BRANCH" --force && break
  echo "  (fetch attempt $attempt failed, retrying...)"
  sleep 2
done
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"
echo "HEAD: $(git log --oneline -1)"

# Self-update: re-exec if the script changed
NEW_HASH=$(md5sum "$SELF" 2>/dev/null | cut -d' ' -f1)
if [ "$OLD_HASH" != "$NEW_HASH" ]; then
  echo "(redeploy.sh updated, re-executing...)"
  exec bash "$SELF"
fi

echo ""
echo "=== Step 2: Copy dist files ==="
mkdir -p "$DST"
# Copy EVERY compiled file under dist/src/ — do not hardcode a whitelist. A static
# list silently drops newly-added modules (e.g. no-context-detect.js): index.js then
# imports a file that was never deployed → plugin load fails → "plugin not found:
# topic-router" → Invalid config. Enumerate from the committed tree so any new .js is
# picked up automatically.
COPIED=0
while IFS= read -r f; do
  # f looks like "dist/src/foo.js"; strip the "dist/src/" prefix for the destination.
  rel="${f#dist/src/}"
  mkdir -p "$DST/$(dirname "$rel")"
  git show "HEAD:$f" > "$DST/$rel"
  COPIED=$((COPIED + 1))
done < <(git ls-tree -r --name-only HEAD dist/src | grep '\.js$')
git show HEAD:dist/index.js > /app/dist/extensions/topic-router/index.js

# Deploy the plugin manifest. WITHOUT activation.onStartup the gateway discovers the
# directory but never activates the plugin — it silently drops from the load list (no
# "loading topic-router" log, no error), even with enabled:true in config. A manifest
# lacking this field is exactly how topic-router went missing in prod. Ship the
# committed manifest as the single source of truth and hard-fail if it regresses.
MANIFEST_DST="/app/dist/extensions/topic-router/openclaw.plugin.json"
git show HEAD:openclaw.plugin.json > "$MANIFEST_DST"
if ! grep -q '"onStartup"' "$MANIFEST_DST"; then
  echo "✗ FATAL: deployed manifest missing activation.onStartup — gateway will not load topic-router. Aborting."
  exit 1
fi
echo "Files copied ($COPIED modules + index.js + manifest)."

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
check "llm-client — mimo-v2.5-mit model" "mimo-v2.5-mit" "$DST/llm-client.js"
check "hook-handler — session routing" "sessionKey" "$DST/hook-handler.js"
check "v4 — feedback-store" "adaptThresholds" "$DST/feedback-store.js"
check "v4 — context-bridge" "checkMerge" "$DST/context-bridge.js"

if [ "$PASS" = false ]; then
  echo ""
  echo "⚠️  Some checks failed. Continuing with restart anyway..."
fi

echo ""
echo "=== Step 3.5: Unify load path (use bundled /app/dist, drop stray overrides) ==="
# The gateway must load topic-router from the bundled /app/dist copy that this
# script deploys. Stray global-plugin copies under ~/.openclaw/{plugins,extensions}
# (e.g. an `openclaw plugins install --link` override) take precedence and would
# shadow this deploy — so remove them and strip their entry from plugins.load.paths.
# This matches bootstrap.sh's design (it also rm -rf these paths).
for stray in /root/.openclaw/plugins/topic-router /root/.openclaw/extensions/topic-router; do
  if [ -e "$stray" ]; then
    mkdir -p /root/.openclaw/_archive
    mv "$stray" "/root/.openclaw/_archive/$(basename "$stray").$(date +%Y%m%d-%H%M%S)" 2>/dev/null \
      && echo "  Archived stray copy: $stray" \
      || { rm -rf "$stray" && echo "  Removed stray copy: $stray"; }
  fi
done
OCJSON="/root/.openclaw/openclaw.json"
if [ -f "$OCJSON" ]; then
  python3 -c "
import json
p = '$OCJSON'
cfg = json.load(open(p))
paths = cfg.get('plugins', {}).get('load', {}).get('paths')
if isinstance(paths, list):
    kept = [x for x in paths if 'topic-router' not in str(x)]
    if kept != paths:
        cfg['plugins']['load']['paths'] = kept
        json.dump(cfg, open(p, 'w'), indent=2, ensure_ascii=False)
        print('  Removed topic-router from plugins.load.paths')
    else:
        print('  plugins.load.paths already clean')
else:
    print('  No plugins.load.paths to clean')
" 2>/dev/null || echo "  (load.paths cleanup skipped)"
fi

echo ""
echo "=== Step 4: Restart gateway ==="
GW_PORT="${GW_PORT:-18789}"

# Stop gateway — multiple strategies for different container setups
echo "  Stopping old gateway..."
openclaw gateway stop 2>/dev/null && sleep 2 || true
# Kill by pgrep (works when binary is named "openclaw")
kill -9 $(pgrep -x openclaw) 2>/dev/null || true
# Kill by port (works when process is node running openclaw-gateway)
if command -v fuser &>/dev/null; then
  fuser -k "$GW_PORT/tcp" 2>/dev/null || true
elif command -v lsof &>/dev/null; then
  lsof -t -i:"$GW_PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
else
  # Last resort: find node process listening on the port
  ss -tlnp 2>/dev/null | grep ":$GW_PORT" | grep -oP 'pid=\K[0-9]+' | xargs kill -9 2>/dev/null || true
fi
sleep 2

# Verify port is free
if ss -tln 2>/dev/null | grep -q ":$GW_PORT "; then
  echo "  ⚠️ Port $GW_PORT still in use! Trying harder..."
  ss -tlnp 2>/dev/null | grep ":$GW_PORT" | grep -oP 'pid=\K[0-9]+' | xargs kill -9 2>/dev/null || true
  sleep 3
fi

: > /tmp/gw.log

# Ensure plugin enabled in config BEFORE starting gateway
OCJSON="/root/.openclaw/openclaw.json"
if [ -f "$OCJSON" ]; then
  python3 -c "
import json
with open('$OCJSON') as f:
    cfg = json.load(f)
if 'plugins' not in cfg: cfg['plugins'] = {}
if 'entries' not in cfg['plugins']: cfg['plugins']['entries'] = {}
cfg['plugins']['entries']['topic-router'] = {'enabled': True}
with open('$OCJSON', 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
" 2>/dev/null && echo "  Config: topic-router enabled" || true
fi

# Start gateway directly — no external script dependency
export HOME=/root
export SYSTEM_PROMPTS_DIR=/root/.openclaw/system-prompts
export XDG_DATA_HOME=/root/.openclaw/xdg-data

if command -v runuser &>/dev/null && id node &>/dev/null 2>&1; then
  runuser -u node -- env HOME=/root SYSTEM_PROMPTS_DIR="$SYSTEM_PROMPTS_DIR" XDG_DATA_HOME="$XDG_DATA_HOME" \
    openclaw gateway --port "$GW_PORT" --verbose &>/tmp/gw.log &
else
  openclaw gateway --port "$GW_PORT" --verbose &>/tmp/gw.log &
fi
disown

echo "Waiting for gateway..."
for i in $(seq 1 30); do
  sleep 2
  # Match multiple possible "started" log patterns
  if grep -qE "http server listening|listening on.*:$GW_PORT|Gateway.*started|plugins loaded" /tmp/gw.log 2>/dev/null; then
    echo "✓ Gateway started (${i}x2s)"
    echo ""
    echo "=== Step 5: Confirm plugin loaded ==="
    grep "topic-router" /tmp/gw.log | head -5
    echo ""

    # Ensure plugin enabled in config (gateway may reset on boot)
    OCJSON="/root/.openclaw/openclaw.json"
    if [ -f "$OCJSON" ]; then
      python3 -c "
import json
with open('$OCJSON') as f:
    cfg = json.load(f)
entries = cfg.get('plugins', {}).get('entries', {})
tr = entries.get('topic-router', {})
if not tr.get('enabled', False):
    if 'plugins' not in cfg: cfg['plugins'] = {}
    if 'entries' not in cfg['plugins']: cfg['plugins']['entries'] = {}
    cfg['plugins']['entries']['topic-router'] = {'enabled': True}
    with open('$OCJSON', 'w') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    print('  Fixed: re-enabled topic-router in openclaw.json')
else:
    print('  Plugin enabled in config ✓')
" 2>/dev/null || true
    fi

    if grep -q "topic-router" /tmp/gw.log; then
      echo "=== ✓ Deploy complete ==="
    else
      echo "=== ⚠️ Gateway started but topic-router not loaded! ==="
      exit 1
    fi
    exit 0
  fi
  # Early exit if gateway reports fatal error
  if grep -qE "failed to start|Cannot find module|SyntaxError" /tmp/gw.log 2>/dev/null; then
    echo "✗ Gateway failed to start:"
    grep -E "failed to start|Cannot find|Error|SyntaxError" /tmp/gw.log | head -5
    exit 1
  fi
done
echo "✗ Gateway not ready after 60s. Last 20 lines:"
tail -20 /tmp/gw.log
exit 1
