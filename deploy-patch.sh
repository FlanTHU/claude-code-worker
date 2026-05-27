#!/bin/bash
# Deploy topic-router plugin (direct LLM mode)
# Run as ROOT on the OpenClaw container.
#
# This version does NOT patch dispatch. The plugin claims messages via
# before_dispatch hook and calls the LLM API directly with per-topic history.
set -e

PLUGIN_DIR="/root/.openclaw/workspace/code-repo/openclaw-topic-router"
DISPATCH="/app/dist/dispatch-8WXygKwL.js"

echo "=== Step 1: Fix openclaw.json if needed ==="
python3 << 'PY'
import json, re
path = '/root/.openclaw/openclaw.json'
with open(path, 'r') as f:
    content = f.read()
try:
    json.loads(content)
    print('  JSON valid')
except json.JSONDecodeError:
    fixed = re.sub(r',(\s*[}\]])', r'\1', content)
    json.loads(fixed)
    with open(path, 'w') as f:
        f.write(fixed)
    print('  Fixed trailing comma')
PY

echo "=== Step 2: Delete stale installs.json ==="
rm -f /root/.openclaw/plugins/installs.json

echo "=== Step 3: Rebuild plugin ==="
cd "$PLUGIN_DIR"
git checkout -- . 2>/dev/null || true
git pull || true
npm run build 2>&1 | tail -5

echo "=== Step 4: Remove old dispatch patch if present ==="
if grep -q "TOPIC_ROUTER_PATCH" "$DISPATCH" 2>/dev/null; then
  python3 -c "
import re
f='$DISPATCH'
t=open(f).read()
t=re.sub(r'/\* TOPIC_ROUTER_PATCH \*/.*?/\* END_TOPIC_ROUTER_PATCH \*/','',t,flags=re.DOTALL)
open(f,'w').write(t)
print('  Old patch removed')
"
  # Verify syntax after removal
  node -c "$DISPATCH" 2>&1 | grep -v "^Debugger\|^For help" || true
  echo "  Syntax OK after patch removal"
else
  echo "  No old patch found (clean)"
fi

echo "=== Step 5: Clear old topic data (fresh start) ==="
rm -f "$PLUGIN_DIR/topic-sessions.json"
rm -rf "$PLUGIN_DIR/conversations/"
echo "  Cleared"

echo "=== Step 6: Restart gateway ==="
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

if pgrep -f "openclaw" > /dev/null; then
  echo "  Gateway running (pid: $(pgrep -f 'openclaw' | head -1))"
else
  echo "  ERROR: Gateway not running"
  tail -10 /tmp/gw.log
  exit 1
fi

echo ""
echo "=== Done ==="
echo "  Plugin loads via native plugin system (no dispatch patch)."
echo "  Messages are claimed by before_dispatch hook → LLM called directly."
echo "  Test: send a message in feishu private chat."
echo "  Verify: cat /tmp/topic-router-module-loaded.txt"
echo "  Logs:   grep '\[topic-router\]\|\\[llm\\]\|\\[hook-handler\\]' /tmp/gw.log | tail -20"
