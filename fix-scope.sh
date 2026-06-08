#!/bin/bash
# One-shot repair for the live gateway dispatch file.
#
# Bug: patch-gateway.sh (old version) inserted the session re-routing block
# AFTER the `if (hookRunner?.hasHooks("before_dispatch")) { ... }` block's
# closing brace. `beforeDispatchResult` is declared with `const` INSIDE that
# block, so the misplaced code references it out of scope ->
#   ReferenceError: beforeDispatchResult is not defined
# which crashes every message dispatch.
#
# This script:
#   1. removes the misplaced routing block (wherever it landed)
#   2. re-inserts it INSIDE the before_dispatch block, right after the
#      `if (beforeDispatchResult?.handled) { ... }` branch (in scope)
#   3. node -c syntax check; restores backup on failure
#
# Run as root inside the OpenClaw container, then restart the gateway.
set -e

echo "=== Gateway scope-fix repair ==="

DISPATCH_FILE=$(grep -l "acpDispatchSessionKey\|before_dispatch_handled" /app/dist/dispatch-[A-Za-z0-9_-]*.js 2>/dev/null | head -1)
if [ -z "$DISPATCH_FILE" ]; then
  echo "ERROR: Cannot find dispatch file"
  exit 1
fi
echo "  File: $DISPATCH_FILE"

cp "$DISPATCH_FILE" "${DISPATCH_FILE}.scopefix.bak"

python3 -c "
import re, sys

f = '$DISPATCH_FILE'
content = open(f).read()
lines = content.split('\n')

# --- Step 1: locate and remove the existing (misplaced) routing block ---
# It is the block that starts with the sessionKey re-route guard.
start = end = -1
for i, line in enumerate(lines):
    if 'beforeDispatchResult?.sessionKey' in line and 'acpDispatchSessionKey' in line:
        start = i
        break

if start != -1:
    # find matching close: the standalone '}' that ends this if-block,
    # i.e. the line right before 'if (hookRunner?.hasHooks(\"reply_dispatch\"))'
    for j in range(start + 1, len(lines)):
        if 're-routed to' in lines[j]:
            # the closing brace is the next standalone '}' after the log line
            for k in range(j + 1, min(j + 4, len(lines))):
                if lines[k].strip() == '}':
                    end = k
                    break
            break
    if end == -1:
        print('ERROR: found routing block start but not its end')
        sys.exit(1)
    del lines[start:end + 1]
    print('  Removed misplaced routing block (lines %d-%d)' % (start + 1, end + 1))
else:
    print('  No existing routing block found (clean file)')

# --- Step 2: find the correct in-scope insertion point ---
# After the `if (beforeDispatchResult?.handled)` branch ends.
insert_idx = -1
found_handled = False
for i, line in enumerate(lines):
    if 'before_dispatch_handled' in line and 'recordProcessed' in line:
        found_handled = True
        continue
    if found_handled and 'return attachSourceReplyDeliveryMode' in line:
        for j in range(i + 1, min(i + 12, len(lines))):
            if lines[j].strip() == '}':
                insert_idx = j + 1
                break
        break

if insert_idx == -1:
    print('ERROR: could not find in-scope insertion point')
    sys.exit(1)

# Scope guard: must still be inside the before_dispatch block.
k = insert_idx
while k < len(lines) and lines[k].strip() == '':
    k += 1
if k < len(lines) and 'reply_dispatch' in lines[k] and 'hasHooks' in lines[k]:
    print('ERROR: insertion point is outside the before_dispatch block')
    sys.exit(1)

anchor = lines[insert_idx - 1]
indent = anchor[:len(anchor) - len(anchor.lstrip())]
if not indent:
    indent = '\t\t\t\t'

routing = (
    f'{indent}if (beforeDispatchResult?.sessionKey && beforeDispatchResult.sessionKey !== acpDispatchSessionKey) {{\n'
    f'{indent}\tacpDispatchSessionKey = beforeDispatchResult.sessionKey;\n'
    f'{indent}\tctx.SessionKey = acpDispatchSessionKey;\n'
    f'{indent}\tsessionStoreEntry = resolveSessionStoreLookup({{ ...ctx, SessionKey: acpDispatchSessionKey }}, cfg);\n'
    f'{indent}\tsessionAgentId = resolveSessionAgentId({{ sessionKey: acpDispatchSessionKey, config: cfg }});\n'
    f'{indent}\tsessionAgentCfg = resolveAgentConfig(cfg, sessionAgentId);\n'
    f'{indent}\tconsole.log(\`[before_dispatch] session re-routed to: \${{acpDispatchSessionKey}}\`);\n'
    f'{indent}}}'
)
lines.insert(insert_idx, routing)
open(f, 'w').write('\n'.join(lines))
print('  Re-inserted routing block in scope at line %d' % (insert_idx + 1))
"

# --- Step 3: syntax check ---
if ! node -c "$DISPATCH_FILE" 2>/tmp/scopefix-syntax.err; then
  echo "  ✗ Syntax check FAILED — restoring backup:"
  sed 's/^/      /' /tmp/scopefix-syntax.err
  cp "${DISPATCH_FILE}.scopefix.bak" "$DISPATCH_FILE"
  exit 1
fi
echo "  ✓ Syntax OK"

echo ""
echo "=== Done. Restart gateway to apply. ==="
echo "  Then send a Feishu message and check: grep 're-routed to' /tmp/gw.log"
