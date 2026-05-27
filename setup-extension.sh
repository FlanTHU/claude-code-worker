#!/bin/bash
# Setup topic-router as an OpenClaw extension
# Run on container: bash setup-extension.sh
set -e

REPO_DIR="/root/.openclaw/workspace/code-repo"
EXT_DIR="/app/dist/extensions/topic-router"

echo "=== Step 1: Remove duplicate global plugin ==="
rm -rf /root/.openclaw/extensions/topic-router
rm -rf /root/.openclaw/plugins/topic-router

echo "=== Step 2: Create extension directory ==="
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR/src"

echo "=== Step 3: Copy compiled JS ==="
cp "$REPO_DIR/dist/index.js" "$EXT_DIR/"
cp "$REPO_DIR/dist/src/"*.js "$EXT_DIR/src/"

echo "=== Step 3.5: Write package.json for ESM ==="
cat > "$EXT_DIR/package.json" << 'PKGJSON'
{"name":"topic-router","type":"module","version":"0.1.0"}
PKGJSON

echo "=== Step 4: Write plugin manifest ==="
cat > "$EXT_DIR/openclaw.plugin.json" << 'MANIFEST'
{
  "id": "topic-router",
  "activation": {
    "onStartup": true
  },
  "enabledByDefault": true,
  "name": "Topic Router",
  "version": "0.1.0",
  "description": "自动将私聊消息路由到话题隔离的 session",
  "main": "./index.js",
  "commandAliases": [
    { "name": "topics", "kind": "runtime-slash" },
    { "name": "switch", "kind": "runtime-slash" },
    { "name": "new", "kind": "runtime-slash" },
    { "name": "end", "kind": "runtime-slash" }
  ],
  "configSchema": {
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "default": true }
    }
  }
}
MANIFEST

echo "=== Step 4.5: Register in openclaw.json ==="
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
print('  Added topic-router to plugins.entries')
"
fi

echo "=== Step 5: Write ESM-compatible diagnostic wrapper ==="
cat > "$EXT_DIR/diag.mjs" << 'DIAG'
import fs from 'node:fs';
fs.writeFileSync('/tmp/topic-router-module-loaded.txt', `module loaded at ${new Date().toISOString()}\n`);
DIAG

echo "=== Step 6: Clear old topic data ==="
rm -f "$REPO_DIR/topic-sessions.json"
rm -rf "$REPO_DIR/conversations/"

echo "=== Step 7: Restart gateway ==="
pkill -9 -f "openclaw" 2>/dev/null || true
sleep 3

cat > /tmp/sg.sh << 'GWEOF'
#!/bin/bash
export HOME=/root
export SYSTEM_PROMPTS_DIR=/root/.openclaw/system-prompts
export XDG_DATA_HOME=/root/.openclaw/xdg-data
exec openclaw gateway --port 18789 --verbose
GWEOF
chmod +x /tmp/sg.sh
runuser -u node -- /tmp/sg.sh &>/tmp/gw.log &
sleep 10

echo "=== Step 8: Check results ==="
if pgrep -f "openclaw" > /dev/null; then
  echo "  Gateway running (pid: $(pgrep -f 'openclaw' | head -1))"
else
  echo "  ERROR: Gateway not running"
  tail -20 /tmp/gw.log
  exit 1
fi

echo ""
echo "--- Plugin loading check ---"
grep -i "topic-router\|plugin.*error\|plugin.*fail\|manifest" /tmp/gw.log | head -15
echo ""
echo "--- Registered commands ---"
grep -i "Registered.*command" /tmp/gw.log
echo ""
echo "=== Done ==="
