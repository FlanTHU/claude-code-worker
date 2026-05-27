#!/bin/bash
echo "=== Diagnostic probe files ==="
cat /tmp/topic-router-module-loaded.txt 2>&1
cat /tmp/topic-router-register.txt 2>&1

echo ""
echo "=== Other plugin locations ==="
find /app/dist/extensions -maxdepth 2 -name "*.json" 2>/dev/null | head -20

echo ""
echo "=== Our extension dir ==="
ls -la /app/dist/extensions/topic-router/ 2>/dev/null

echo ""
echo "=== openclaw.json plugin config ==="
cat /root/.openclaw/openclaw.json 2>/dev/null | python3 -m json.tool 2>/dev/null | grep -A5 -i "plugin\|extension" | head -30

echo ""
echo "=== All dirs under /app/dist/extensions ==="
ls /app/dist/extensions/ 2>/dev/null

echo ""
echo "=== Gateway full plugin/extension logs ==="
grep -iE "plugin|extension|topic|error|fail|load" /tmp/gw.log | grep -v "mcp\|acpx" | head -40

echo ""
echo "=== Where do working plugins live? ==="
find / -name "openclaw.plugin.json" -not -path "*/node_modules/*" 2>/dev/null | head -10

echo ""
echo "=== device-pair plugin structure ==="
PAIR_DIR=$(find / -path "*/device-pair/openclaw.plugin.json" -not -path "*/node_modules/*" 2>/dev/null | head -1)
if [ -n "$PAIR_DIR" ]; then
  echo "Found at: $PAIR_DIR"
  dirname "$PAIR_DIR" | xargs ls -la
  echo "--- manifest ---"
  cat "$PAIR_DIR"
fi
