#!/bin/bash
# Bootstrap topic-router plugin on a fresh OpenClaw container.
#
# ⚠️  DESTRUCTIVE: kills gateway, patches /app/dist/ JS, modifies openclaw.json.
#     Do NOT run on a container that is actively serving users unless you intend
#     to restart. Use redeploy.sh for code-only updates without re-patching.
#
# Usage (fresh container):
#   git clone -b main https://github.com/FlanTHU/claude-code-worker.git /tmp/tr
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

REPO_URL="${REPO_URL:-https://github.com/FlanTHU/claude-code-worker.git}"
GIT_ROOT="/root/.openclaw/workspace/code-repo"
PLUGIN_DIR="$GIT_ROOT"
EXT_DIR="/app/dist/extensions/topic-router"
BRANCH="main"
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
git config --global http.sslVerify false 2>/dev/null || true

if [ -d "$GIT_ROOT/.git" ]; then
  cd "$GIT_ROOT"
  # Try to fetch with retries (network to github is slow/flaky); don't fail if
  # unavailable — fall back to local code. Slow-speed detection aborts a stalled
  # transfer fast so the retry can kick in (mirrors redeploy.sh).
  git config --global http.lowSpeedLimit 1000 2>/dev/null || true
  git config --global http.lowSpeedTime 10 2>/dev/null || true
  fetched=""
  for attempt in 1 2 3; do
    if timeout 30 git fetch origin "$BRANCH" --force 2>/dev/null; then
      fetched="1"; break
    fi
    echo "  (fetch attempt $attempt failed, retrying...)"
    sleep 2
  done
  [ -z "$fetched" ] && echo "  (fetch failed/timed out after 3 tries, using local code)"
  git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH" 2>/dev/null || true
  git reset --hard "origin/$BRANCH" 2>/dev/null || true
elif [ -d "$GIT_ROOT" ]; then
  # Directory exists but not a git repo (e.g. tarball extract) — init and use as-is
  cd "$GIT_ROOT"
  git init -b "$BRANCH" 2>/dev/null || true
  git remote add origin "$REPO_URL" 2>/dev/null || true
  echo "  (using existing code directory)"
else
  mkdir -p "$(dirname "$GIT_ROOT")"
  git clone -b "$BRANCH" "$REPO_URL" "$GIT_ROOT"
  cd "$GIT_ROOT"
fi
echo "  HEAD: $(git log --oneline -1 2>/dev/null || echo 'tarball (no git history)')"

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
GW_PORT="${GW_PORT:-18789}"
openclaw gateway stop 2>/dev/null && sleep 2 || true
pkill -9 -f "openclaw gateway" 2>/dev/null || true
kill -9 $(pgrep -x openclaw) 2>/dev/null || true
if command -v fuser &>/dev/null; then
  fuser -k "$GW_PORT/tcp" 2>/dev/null || true
elif command -v lsof &>/dev/null; then
  lsof -t -i:"$GW_PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
else
  ss -tlnp 2>/dev/null | grep ":$GW_PORT" | grep -oP 'pid=\K[0-9]+' | xargs kill -9 2>/dev/null || true
fi
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
if [ "${GW_RUN_CMD:-}" = "direct" ] || ! command -v runuser &>/dev/null || ! id node &>/dev/null 2>&1; then
  "$GW_SCRIPT" &>/tmp/gw.log &
else
  runuser -u node -- env HOME=/root SYSTEM_PROMPTS_DIR=/root/.openclaw/system-prompts XDG_DATA_HOME=/root/.openclaw/xdg-data \
    openclaw gateway --port "$GW_PORT" --verbose &>/tmp/gw.log &
fi
disown

echo "  Waiting for gateway..."
for i in $(seq 1 25); do
  sleep 2
  if grep -qE "http server listening|listening on.*:${GW_PORT:-18789}|Gateway.*started|plugins loaded" /tmp/gw.log 2>/dev/null; then
    echo "  Gateway started (${i}x2s)"
    break
  fi
  if [ "$i" -eq 25 ]; then
    echo "  ERROR: Gateway not ready after 50s"
    tail -15 /tmp/gw.log
    exit 1
  fi
done

# Re-ensure plugin enabled AFTER gateway starts (gateway may reset config on boot)
sleep 2
if [ -f "$OCJSON" ]; then
  python3 -c "
import json
with open('$OCJSON') as f:
    cfg = json.load(f)
changed = False
entries = cfg.get('plugins', {}).get('entries', {})
tr = entries.get('topic-router', {})
if not tr.get('enabled', False):
    if 'plugins' not in cfg: cfg['plugins'] = {}
    if 'entries' not in cfg['plugins']: cfg['plugins']['entries'] = {}
    cfg['plugins']['entries']['topic-router'] = {'enabled': True}
    with open('$OCJSON', 'w') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    print('  Re-enabled topic-router in openclaw.json (gateway had reset it)')
    changed = True
if not changed:
    print('  Plugin already enabled in openclaw.json')
" 2>/dev/null || true
fi

# ── Step 5: Verify ──
echo ""
echo "[5/5] Verification..."
PASS=true

verify() {
  if eval "$2"; then
    echo "  ✓ $1"
  else
    echo "  ✗ $1"
    PASS=false
  fi
}

verify "Gateway running" "pgrep -f openclaw >/dev/null 2>&1"
verify "Plugin loaded" "grep -q topic-router /tmp/gw.log"
verify "Gateway patch (dispatch)" "grep -ql 'session re-routed' /app/dist/dispatch-*.js 2>/dev/null"
verify "Gateway patch (hook-runner)" "grep -ql 'before_dispatch.*sessionKey' /app/dist/hook-runner-global-*.js 2>/dev/null"
verify "Extension manifest" "test -f $EXT_DIR/openclaw.plugin.json"

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
  NEED_RESTART=0
  if ! grep -q "session re-routed" /app/dist/dispatch-*.js 2>/dev/null; then
    echo "Gateway patches missing, re-applying..."
    bash "$GIT_ROOT/patch-gateway.sh"
    NEED_RESTART=1
  fi

  # Always ensure config has plugin enabled
  OCJSON="/root/.openclaw/openclaw.json"
  if [ -f "$OCJSON" ]; then
    python3 -c "
import json
with open('$OCJSON') as f:
    cfg = json.load(f)
if 'plugins' not in cfg: cfg['plugins'] = {}
if 'entries' not in cfg['plugins']: cfg['plugins']['entries'] = {}
tr = cfg['plugins']['entries'].get('topic-router', {})
if not tr.get('enabled', False):
    cfg['plugins']['entries']['topic-router'] = {'enabled': True}
    with open('$OCJSON', 'w') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    print('Re-enabled topic-router in config')
" 2>/dev/null || true
  fi

  if [ "$NEED_RESTART" = "1" ]; then
    openclaw gateway stop 2>/dev/null || true
    pkill -9 -f "openclaw gateway" 2>/dev/null || true
    kill -9 $(pgrep -x openclaw) 2>/dev/null || true
    fuser -k 18789/tcp 2>/dev/null || lsof -t -i:18789 2>/dev/null | xargs kill -9 2>/dev/null || true
    sleep 2
    : > /tmp/gw.log
    export HOME=/root
    export SYSTEM_PROMPTS_DIR=/root/.openclaw/system-prompts
    export XDG_DATA_HOME=/root/.openclaw/xdg-data
    if command -v runuser &>/dev/null && id node &>/dev/null 2>&1; then
      runuser -u node -- env HOME=/root SYSTEM_PROMPTS_DIR="$SYSTEM_PROMPTS_DIR" XDG_DATA_HOME="$XDG_DATA_HOME" \
        openclaw gateway --port 18789 --verbose &>/tmp/gw.log &
    else
      openclaw gateway --port 18789 --verbose &>/tmp/gw.log &
    fi
    disown
    echo "Gateway restarted with patches"
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
