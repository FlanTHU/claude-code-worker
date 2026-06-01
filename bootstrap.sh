#!/bin/bash
# Bootstrap topic-router plugin on a fresh OpenClaw container.
#
# ⚠️  DESTRUCTIVE: kills gateway, patches /app/dist/ JS, modifies openclaw.json.
#     Do NOT run on a container that is actively serving users unless you intend
#     to restart. Use redeploy.sh for code-only updates without re-patching.
#
# Usage (fresh container):
#   git clone -b v2-direct-llm https://github.com/FlanTHU/claude-code-worker.git /tmp/tr
#   bash /tmp/tr/bootstrap.sh
#
# Usage (existing container, force restart):
#   FORCE_BOOTSTRAP=1 bash /root/.openclaw/workspace/code-repo/bootstrap.sh
#
# Prerequisites:
#   - OpenClaw gateway installed at /app/dist/
#   - Git available
#   - Container has network access to github.com
#   - Gateway process owner: node user (runuser -u node)
set -e

REPO_URL="https://github.com/FlanTHU/claude-code-worker.git"
GIT_ROOT="/root/.openclaw/workspace/code-repo"
PLUGIN_DIR="$GIT_ROOT"
EXT_DIR="/app/dist/extensions/topic-router"
BRANCH="v2-direct-llm"
STATE_DIR="/root/.openclaw/topic-router-state"

# Safety check: refuse to run if gateway is currently serving traffic
if [ "${FORCE_BOOTSTRAP:-}" != "1" ]; then
  if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    echo "⚠️  Gateway is running. This script will restart it."
    echo "   Set FORCE_BOOTSTRAP=1 to proceed, or use redeploy.sh for hot-reload."
    echo ""
    echo "   FORCE_BOOTSTRAP=1 bash bootstrap.sh"
    exit 1
  fi
fi

echo "╔══════════════════════════════════════════════╗"
echo "║   Topic Router — One-Click Bootstrap        ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Step 1: Clone or update repo ──
echo "[1/5] Fetching code..."
git config --global --add safe.directory "$GIT_ROOT" 2>/dev/null || true

if [ -d "$GIT_ROOT/.git" ]; then
  cd "$GIT_ROOT"
  git fetch origin "$BRANCH" --force
  git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  mkdir -p "$(dirname "$GIT_ROOT")"
  git clone -b "$BRANCH" "$REPO_URL" "$GIT_ROOT"
  cd "$GIT_ROOT"
fi
echo "  HEAD: $(git log --oneline -1)"

if [ ! -d "$PLUGIN_DIR/dist" ]; then
  echo "  ERROR: $PLUGIN_DIR/dist not found"
  exit 1
fi

# ── Step 2: Install extension ──
echo ""
echo "[2/5] Installing extension..."

# Remove stale copies
rm -rf /root/.openclaw/extensions/topic-router
rm -rf /root/.openclaw/plugins/topic-router
rm -rf "$EXT_DIR"

# Create extension structure
mkdir -p "$EXT_DIR/src"
cp "$PLUGIN_DIR/dist/index.js" "$EXT_DIR/"
cp "$PLUGIN_DIR/dist/src/"*.js "$EXT_DIR/src/"

cat > "$EXT_DIR/package.json" << 'EOF'
{"name":"topic-router","type":"module","version":"0.1.0"}
EOF

cat > "$EXT_DIR/openclaw.plugin.json" << 'EOF'
{
  "id": "topic-router",
  "activation": { "onStartup": true },
  "enabledByDefault": true,
  "name": "Topic Router",
  "version": "0.1.0",
  "description": "自动将私聊消息路由到话题隔离的 session",
  "main": "./index.js",
  "commandAliases": [
    { "name": "topics", "kind": "runtime-slash" },
    { "name": "switch", "kind": "runtime-slash" },
    { "name": "newtopic", "kind": "runtime-slash" },
    { "name": "end", "kind": "runtime-slash" },
    { "name": "endall", "kind": "runtime-slash" }
  ],
  "configSchema": {
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "default": true }
    }
  }
}
EOF

# Register in openclaw.json
OCJSON="/root/.openclaw/openclaw.json"
if [ -f "$OCJSON" ]; then
  python3 -c "
import json
with open('$OCJSON') as f:
    cfg = json.load(f)
if 'plugins' not in cfg:
    cfg['plugins'] = {}
if 'entries' not in cfg['plugins']:
    cfg['plugins']['entries'] = {}
cfg['plugins']['entries']['topic-router'] = {'enabled': True}
with open('$OCJSON', 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
print('  Registered in openclaw.json')
"
fi

# Create state directory (persistent across restarts)
mkdir -p "$STATE_DIR"
chmod 777 "$STATE_DIR"
# Migrate old state from /tmp if exists
if [ -d "/tmp/topic-router-state" ] && [ ! -d "/tmp/topic-router-state/.migrated" ]; then
  cp -n /tmp/topic-router-state/*.json "$STATE_DIR/" 2>/dev/null || true
  touch /tmp/topic-router-state/.migrated
fi
echo "  Extension installed at $EXT_DIR"

# ── Step 3: Patch gateway for sessionKey routing ──
echo ""
echo "[3/5] Patching gateway..."
bash "$PLUGIN_DIR/patch-gateway.sh"

# ── Step 4: Restart gateway ──
echo ""
echo "[4/5] Restarting gateway..."
pkill -9 -f "openclaw" 2>/dev/null || true
sleep 3

# Write gateway startup script to persistent path + symlink to /tmp
GW_SCRIPT="/root/.openclaw/sg.sh"
cat > "$GW_SCRIPT" << 'GWEOF'
#!/bin/bash
export HOME=/root
export SYSTEM_PROMPTS_DIR=/root/.openclaw/system-prompts
export XDG_DATA_HOME=/root/.openclaw/xdg-data
exec openclaw gateway --port 18789 --verbose
GWEOF
chmod +x "$GW_SCRIPT"
ln -sf "$GW_SCRIPT" /tmp/sg.sh

: > /tmp/gw.log
runuser -u node -- "$GW_SCRIPT" &>/tmp/gw.log &
disown

echo "  Waiting for gateway..."
for i in $(seq 1 25); do
  sleep 2
  if grep -q "http server listening" /tmp/gw.log 2>/dev/null; then
    echo "  Gateway started (${i}x2s)"
    break
  fi
  if [ "$i" -eq 25 ]; then
    echo "  ERROR: Gateway not ready after 50s"
    tail -15 /tmp/gw.log
    exit 1
  fi
done

# ── Step 5: Verify ──
echo ""
echo "[5/5] Verification..."
PASS=true

verify() {
  if $2; then
    echo "  ✓ $1"
  else
    echo "  ✗ $1"
    PASS=false
  fi
}

verify "Gateway running" "pgrep -f openclaw > /dev/null"
verify "Plugin loaded" "grep -q 'topic-router' /tmp/gw.log"
verify "Gateway patch (dispatch)" "grep -q 'session re-routed' /app/dist/dispatch-*.js 2>/dev/null"
verify "Gateway patch (hook-runner)" "grep -q 'before_dispatch.*sessionKey' /app/dist/hook-runner-global-*.js 2>/dev/null"
verify "Extension manifest" "[ -f '$EXT_DIR/openclaw.plugin.json' ]"

echo ""
if [ "$PASS" = true ]; then
  echo "══════════════════════════════════════"
  echo "  ✓ Topic Router deployed successfully"
  echo "══════════════════════════════════════"
else
  echo "⚠️  Some checks failed. Check /tmp/gw.log for details."
  exit 1
fi

# ── Bonus: Install on-boot auto-recovery ──
ON_BOOT="/root/.openclaw/on-boot.sh"
cat > "$ON_BOOT" << 'AEOF'
#!/bin/bash
# Auto-recovery for topic-router after container restart.
# Called by: container entrypoint, crontab @reboot, or manual invocation.
LOG="/root/.openclaw/topic-router-boot.log"
exec >> "$LOG" 2>&1
echo ""
echo "=== on-boot.sh triggered at $(date) ==="

GIT_ROOT="/root/.openclaw/workspace/code-repo"
EXT_DIR="/app/dist/extensions/topic-router"

# Wait for filesystem to be ready
sleep 3

# If extension is missing from /app/dist/, re-deploy
if [ ! -f "$EXT_DIR/index.js" ]; then
  echo "Extension missing, running bootstrap..."
  if [ -f "$GIT_ROOT/bootstrap.sh" ]; then
    FORCE_BOOTSTRAP=1 bash "$GIT_ROOT/bootstrap.sh"
  else
    echo "ERROR: bootstrap.sh not found at $GIT_ROOT"
  fi
else
  # Extension exists but patches might be gone (new gateway binary)
  if ! grep -q "session re-routed" /app/dist/dispatch-*.js 2>/dev/null; then
    echo "Gateway patches missing, re-applying..."
    bash "$GIT_ROOT/patch-gateway.sh"
    # Restart gateway to pick up patches
    pkill -9 -f "openclaw" 2>/dev/null || true
    sleep 2
    GW_SCRIPT="/root/.openclaw/sg.sh"
    if [ -f "$GW_SCRIPT" ]; then
      : > /tmp/gw.log
      runuser -u node -- "$GW_SCRIPT" &>/tmp/gw.log &
      disown
      echo "Gateway restarted with patches"
    fi
  else
    echo "Everything intact, no action needed"
  fi
fi
echo "=== on-boot.sh done ==="
AEOF
chmod +x "$ON_BOOT"

# Register in crontab (best-effort, cron may not run in all containers)
(crontab -l 2>/dev/null | grep -v "on-boot.sh"; echo "@reboot /root/.openclaw/on-boot.sh") | crontab - 2>/dev/null || true
echo "  (Installed /root/.openclaw/on-boot.sh for auto-recovery)"
