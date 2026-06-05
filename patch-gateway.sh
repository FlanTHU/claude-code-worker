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

# Insert routing code INSIDE the before_dispatch block, so that the
# block-scoped `const beforeDispatchResult` is still in scope.
#
# CRITICAL: `beforeDispatchResult` is declared with `const` inside
#   if (hookRunner?.hasHooks(\"before_dispatch\")) { ... }
# Inserting the routing code AFTER that block's closing brace puts it out
# of scope -> runtime `ReferenceError: beforeDispatchResult is not defined`.
# We therefore anchor on the END of the `if (beforeDispatchResult?.handled)`
# branch and insert immediately after it -- still inside the outer block.
lines = content.split('\n')
insert_idx = -1

# Anchor: the handled branch ends with
#   recordProcessed(... 'before_dispatch_handled' ...)
#   ...
#   return attachSourceReplyDeliveryMode({ queuedFinal, counts });
#   }            <- closes `if (beforeDispatchResult?.handled)`  (insert AFTER this)
found_handled = False
for i, line in enumerate(lines):
    if 'before_dispatch_handled' in line and 'recordProcessed' in line:
        found_handled = True
        continue
    if found_handled and 'return attachSourceReplyDeliveryMode' in line:
        # find the closing brace of the handled branch (next standalone '}')
        for j in range(i + 1, min(i + 12, len(lines))):
            if lines[j].strip() == '}':
                insert_idx = j + 1
                break
        break

if insert_idx == -1:
    print('ERROR: Could not find in-scope insertion point in dispatch')
    print('       (expected handled-branch ending in attachSourceReplyDeliveryMode)')
    sys.exit(1)

# Scope guard: the very next non-blank line after our insertion point must be
# the closing brace of the before_dispatch block (i.e. we are still INSIDE it).
# If the next meaningful token is `if (hookRunner?.hasHooks(\"reply_dispatch\"))`
# without an intervening `}`, we'd be out of scope -> refuse to patch.
k = insert_idx
while k < len(lines) and lines[k].strip() == '':
    k += 1
if k < len(lines) and 'reply_dispatch' in lines[k] and 'hasHooks' in lines[k]:
    print('ERROR: insertion point is OUTSIDE the before_dispatch block (out of scope)')
    print('       refusing to patch -- would cause ReferenceError at runtime')
    sys.exit(1)

# Derive indent from the closing brace of the handled branch so the inserted
# code lines up with the surrounding block regardless of gateway formatting.
anchor_line = lines[insert_idx - 1]
indent = anchor_line[:len(anchor_line) - len(anchor_line.lstrip())]
if not indent:
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
  # Syntax-check the patched dispatch file; restore backup on failure.
  if ! node -c "$DISPATCH_FILE" 2>/tmp/dispatch-syntax.err; then
    echo "  ✗ Patched dispatch failed syntax check — restoring backup:"
    sed 's/^/      /' /tmp/dispatch-syntax.err
    cp "${DISPATCH_FILE}.bak" "$DISPATCH_FILE"
    exit 1
  fi
  echo "  ✓ Dispatch syntax OK"
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
