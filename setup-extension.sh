#!/bin/bash
# Setup topic-router as an OpenClaw extension
# Run on container: bash setup-extension.sh
set -e

REPO_DIR="/root/.openclaw/workspace/code-repo"
EXT_DIR="/app/dist/extensions/topic-router"

echo "=== Creating extension directory ==="
mkdir -p "$EXT_DIR/src"

echo "=== Copying compiled JS ==="
cp "$REPO_DIR/dist/index.js" "$EXT_DIR/"
cp "$REPO_DIR/dist/src/"*.js "$EXT_DIR/src/"

echo "=== Writing plugin manifest ==="
cat > "$EXT_DIR/openclaw.plugin.json" << 'MANIFEST'
{
  "id": "topic-router",
  "name": "Topic Router",
  "version": "0.1.0",
  "description": "自动将私聊消息路由到话题隔离的 session",
  "main": "./index.js",
  "runtimeExtensions": ["./index.js"],
  "configSchema": {
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "default": true }
    }
  }
}
MANIFEST

echo "=== Clearing old topic data ==="
rm -f "$REPO_DIR/topic-sessions.json"
rm -rf "$REPO_DIR/conversations/"

echo "=== Restarting gateway ==="
pkill -9 -f "openclaw" 2>/dev/null || true
sleep 2

cat > /tmp/sg.sh << 'GWEOF'
#!/bin/bash
export HOME=/root
export SYSTEM_PROMPTS_DIR=/root/.openclaw/system-prompts
export XDG_DATA_HOME=/root/.openclaw/xdg-data
exec openclaw gateway --port 18789 --verbose
GWEOF
chmod +x /tmp/sg.sh
runuser -u node -- /tmp/sg.sh &>/tmp/gw.log &
sleep 8

if cat /tmp/topic-router-module-loaded.txt 2>/dev/null; then
  echo "=== SUCCESS: Plugin loaded ==="
else
  echo "=== FAILED: Checking logs ==="
  grep -i "topic" /tmp/gw.log
fi
