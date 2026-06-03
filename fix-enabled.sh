#!/bin/bash
# Quick fix: re-enable topic-router in openclaw.json and restart gateway.
# Usage: bash fix-enabled.sh
set -e

OCJSON="/root/.openclaw/openclaw.json"
GW_PORT="${GW_PORT:-18789}"

echo "=== Fix topic-router enabled state ==="

# 1. Patch config
if [ ! -f "$OCJSON" ]; then
  echo "ERROR: $OCJSON not found"
  exit 1
fi

python3 -c "
import json
with open('$OCJSON') as f:
    cfg = json.load(f)
if 'plugins' not in cfg: cfg['plugins'] = {}
if 'entries' not in cfg['plugins']: cfg['plugins']['entries'] = {}
old = cfg['plugins']['entries'].get('topic-router', {})
print(f'  Before: {old}')
cfg['plugins']['entries']['topic-router'] = {'enabled': True}
with open('$OCJSON', 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
print('  After: {\"enabled\": true}')
"

# 2. Restart gateway
echo ""
echo "Restarting gateway..."
openclaw gateway stop 2>/dev/null && sleep 2 || true
kill -9 $(pgrep -x openclaw) 2>/dev/null || true
if command -v fuser &>/dev/null; then
  fuser -k "$GW_PORT/tcp" 2>/dev/null || true
elif command -v lsof &>/dev/null; then
  lsof -t -i:"$GW_PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
else
  ss -tlnp 2>/dev/null | grep ":$GW_PORT" | grep -oP 'pid=\K[0-9]+' | xargs kill -9 2>/dev/null || true
fi
sleep 2

: > /tmp/gw.log
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
for i in $(seq 1 20); do
  sleep 2
  if grep -qE "http server listening|listening on.*:$GW_PORT|Gateway.*started|plugins loaded" /tmp/gw.log 2>/dev/null; then
    echo "✓ Gateway started (${i}x2s)"
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "✗ Gateway not ready after 40s"
    tail -10 /tmp/gw.log
    exit 1
  fi
done

# 3. Verify
echo ""
if grep -q "topic-router" /tmp/gw.log; then
  echo "✓ topic-router loaded"
  grep "topic-router" /tmp/gw.log | head -3
else
  echo "⚠️ topic-router not in gateway log"
fi

# Confirm config is still correct (gateway might reset it again)
sleep 3
python3 -c "
import json
with open('$OCJSON') as f:
    cfg = json.load(f)
tr = cfg.get('plugins', {}).get('entries', {}).get('topic-router', {})
if tr.get('enabled'):
    print('✓ Config still has enabled: true')
else:
    print('⚠️ Gateway reset config! Re-applying...')
    cfg['plugins']['entries']['topic-router'] = {'enabled': True}
    with open('$OCJSON', 'w') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    print('  Fixed. May need another restart if gateway caches config at boot.')
"
echo ""
echo "=== Done. Test with: send /topics in Feishu ==="
