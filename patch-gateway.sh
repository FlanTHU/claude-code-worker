#!/bin/bash
# Patch gateway for before_dispatch sessionKey routing support.
# Run inside the container: bash /tmp/patch-gateway.sh
set -e

echo "=== Gateway Session Routing Patch ==="
echo ""

# --- Patch 1: dispatch file (const→let + routing code) ---
# Find the file containing actual dispatch logic (not a re-export stub)
DISPATCH_FILE=$(grep -l "acpDispatchSessionKey\|before_dispatch_handled" /app/dist/dispatch-[A-Za-z0-9_-]*.js 2>/dev/null | head -1)
if [ -z "$DISPATCH_FILE" ]; then
  echo "ERROR: Cannot find dispatch file with session key logic"
  exit 1
fi

echo "[1/2] Patching dispatch: $DISPATCH_FILE"

if grep -q "session re-routed to" "$DISPATCH_FILE" 2>/dev/null; then
  echo "  Already patched. Skipping."
else
  cp "$DISPATCH_FILE" "${DISPATCH_FILE}.bak"
  python3 -c "
import sys

dispatch_file = '$DISPATCH_FILE'
with open(dispatch_file, 'r') as f:
    content = f.read()

# const → let
for old, new in [
    ('const acpDispatchSessionKey', 'let acpDispatchSessionKey'),
    ('const sessionStoreEntry', 'let sessionStoreEntry'),
    ('const sessionAgentId', 'let sessionAgentId'),
    ('const sessionAgentCfg', 'let sessionAgentCfg'),
]:
    if old in content:
        content = content.replace(old, new, 1)

# Insert routing code after the before_dispatch block closes, before reply_dispatch
lines = content.split('\n')
insert_idx = -1

# Strategy 1: find closing of 'if (hookRunner?.hasHooks(\"before_dispatch\"))' block
# by locating 'reply_dispatch' hook check that follows it
for i, line in enumerate(lines):
    if 'reply_dispatch' in line and 'hasHooks' in line:
        insert_idx = i
        break

# Strategy 2 (older gateway): find 'return attachSourceReplyDeliveryMode' after handled block
if insert_idx == -1:
    found_marker = False
    for i, line in enumerate(lines):
        if 'before_dispatch_handled' in line and 'recordProcessed' in line:
            found_marker = True
            continue
        if found_marker and 'return attachSourceReplyDeliveryMode' in line:
            for j in range(i + 1, min(i + 10, len(lines))):
                if lines[j].strip() == '}':
                    insert_idx = j + 1
                    break
            break

if insert_idx == -1:
    print('ERROR: Could not find insertion point in dispatch')
    sys.exit(1)

indent = '\t\t\t\t'
routing_code = (
    f'{indent}if (beforeDispatchResult?.sessionKey && beforeDispatchResult.sessionKey !== acpDispatchSessionKey) {{\n'
    f'{indent}\tacpDispatchSessionKey = beforeDispatchResult.sessionKey;\n'
    f'{indent}\tctx.SessionKey = acpDispatchSessionKey;\n'
    f'{indent}\tsessionStoreEntry = resolveSessionStoreLookup({{\n'
    f'{indent}\t\t...ctx,\n'
    f'{indent}\t\tSessionKey: acpDispatchSessionKey\n'
    f'{indent}\t}}, cfg);\n'
    f'{indent}\tsessionAgentId = resolveSessionAgentId({{\n'
    f'{indent}\t\tsessionKey: acpDispatchSessionKey,\n'
    f'{indent}\t\tconfig: cfg\n'
    f'{indent}\t}});\n'
    f'{indent}\tsessionAgentCfg = resolveAgentConfig(cfg, sessionAgentId);\n'
    f'{indent}\tconsole.log(\`[before_dispatch] session re-routed to: \${{acpDispatchSessionKey}}\`);\n'
    f'{indent}}}'
)
lines.insert(insert_idx, routing_code)

with open(dispatch_file, 'w') as f:
    f.write('\n'.join(lines))
print('  ✓ Dispatch patched')
"
fi

# --- Patch 2: hook-runner (allow sessionKey passthrough when handled=false) ---
# Find the file that actually contains the hook logic (not a re-export stub)
HOOK_FILE=$(grep -l "handlerResult?.handled" /app/dist/hook-runner-global-*.js 2>/dev/null | head -1)
if [ -z "$HOOK_FILE" ]; then
  echo "ERROR: Cannot find hook-runner-global file with handlerResult logic"
  exit 1
fi

echo "[2/2] Patching hook-runner: $HOOK_FILE"

if grep -q "before_dispatch.*sessionKey" "$HOOK_FILE" 2>/dev/null; then
  echo "  Already patched. Skipping."
else
  cp "$HOOK_FILE" "${HOOK_FILE}.bak"
  python3 -c "
import sys

hook_file = '$HOOK_FILE'
with open(hook_file, 'r') as f:
    content = f.read()

# Find: 'if (handlerResult?.handled) return handlerResult;'
# Add after it: 'if (hookName === \"before_dispatch\" && handlerResult?.sessionKey) return handlerResult;'

old = 'if (handlerResult?.handled) return handlerResult;'
new = '''if (handlerResult?.handled) return handlerResult;
\t\t\tif (hookName === \"before_dispatch\" && handlerResult?.sessionKey) return handlerResult;'''

if old not in content:
    print('ERROR: Cannot find hook pattern in hook-runner')
    sys.exit(1)

# Only replace the first occurrence (in runClaimingHooksList)
content = content.replace(old, new, 1)

with open(hook_file, 'w') as f:
    f.write(content)
print('  ✓ Hook-runner patched')
"
fi

# --- Verify ---
echo ""
echo "=== Verification ==="
grep -q "session re-routed" "$DISPATCH_FILE" && echo "  ✓ Dispatch: routing code present" || echo "  ✗ Dispatch: MISSING"
grep -q "before_dispatch.*sessionKey" "$HOOK_FILE" && echo "  ✓ Hook-runner: sessionKey passthrough present" || echo "  ✗ Hook-runner: MISSING"
echo ""
echo "=== Done! Restart gateway to apply. ==="
