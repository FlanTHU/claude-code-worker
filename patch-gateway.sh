#!/bin/bash
# Patch gateway for before_dispatch sessionKey routing support.
# Run inside the container: bash /tmp/patch-gateway.sh
#
# CONTRACT: the marker substring "re-routed to" is shared across 4 sites and
# MUST stay in sync if the injected log line is ever reworded:
#   1. DISPATCH_STATE detection      ('session re-routed to' present-check)
#   2. MISPLACED strip bounding      ('re-routed to' end-of-block locator)
#   3. injected routing code         (the console.log emitted into dispatch)
#   4. final verification grep       ('session re-routed' presence check)
# Change one -> change all four, or detection/strip/verify will silently fail.
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

# Decide whether we need to (re)patch. A previous buggy patch may have inserted
# the routing block OUTSIDE the before_dispatch block (out of scope for the
# const-declared beforeDispatchResult). In that case we must NOT skip: we strip
# the misplaced block and re-apply correctly.
DISPATCH_STATE=$(DISPATCH_FILE="$DISPATCH_FILE" python3 - <<'PYEOF'
import sys, os
# Strip string/template literals and // line comments so brace-counting only
# sees code structure: a '}' inside a string or comment must not shift the
# nesting depth. Limitations (acceptable here, and node -c backstops any
# misjudge): does not handle /* */ block comments, escaped quotes, or regex
# literals like /[{}]/ — none of which occur between the before_dispatch
# hasHooks line and its closing brace in the dispatch bundle we patch.
_Q = (chr(39), chr(34), chr(96))
def _code_only(line):
    out = []; i = 0; n = len(line); q = None
    while i < n:
        c = line[i]
        if q is None:
            if c in _Q:
                q = c
            elif c == '/' and i + 1 < n and line[i + 1] == '/':
                break
            else:
                out.append(c)
        elif c == q:
            q = None
        i += 1
    return ''.join(out)
content = open(os.environ['DISPATCH_FILE']).read()
lines = content.split('\n')
if 'session re-routed to' not in content:
    print('UNPATCHED'); sys.exit(0)
# Routing block start line.
ri = next((i for i, l in enumerate(lines)
           if 'beforeDispatchResult?.sessionKey' in l and 'acpDispatchSessionKey' in l), -1)
if ri == -1:
    print('UNPATCHED'); sys.exit(0)
# before_dispatch hasHooks line.
bd = next((i for i, l in enumerate(lines)
           if 'before_dispatch' in l and 'hasHooks' in l), -1)
if bd == -1:
    print('MISPLACED'); sys.exit(0)
# Brace-balance from the before_dispatch hasHooks line to find where its block
# closes. The routing block is in scope iff it starts BEFORE that closing brace.
# Count braces on code only (strings/comments stripped) to avoid miscounting
# braces that live inside log templates or regexes.
depth = 0; started = False; close_idx = -1
for i in range(bd, len(lines)):
    code = _code_only(lines[i])
    opens = code.count('{'); closes = code.count('}')
    depth += opens - closes
    if opens > 0:
        started = True
    if started and depth <= 0:
        close_idx = i; break
print('OK' if (close_idx != -1 and ri < close_idx) else 'MISPLACED')
PYEOF
)
echo "  Dispatch patch state: $DISPATCH_STATE"

if [ "$DISPATCH_STATE" = "OK" ]; then
  echo "  Already patched correctly. Skipping."
else
  cp "$DISPATCH_FILE" "${DISPATCH_FILE}.bak"

  # If a misplaced routing block exists, strip it before re-applying.
  if [ "$DISPATCH_STATE" = "MISPLACED" ]; then
    echo "  Detected MISPLACED routing block (out of scope) — removing before re-apply."
    DISPATCH_FILE="$DISPATCH_FILE" python3 - <<'PYEOF'
import os
dispatch_file = os.environ['DISPATCH_FILE']
lines = open(dispatch_file).read().split('\n')
start = next((i for i, l in enumerate(lines)
              if 'beforeDispatchResult?.sessionKey' in l and 'acpDispatchSessionKey' in l), -1)
if start != -1:
    end = -1
    for j in range(start + 1, len(lines)):
        if 're-routed to' in lines[j]:
            for k in range(j + 1, min(j + 4, len(lines))):
                if lines[k].strip() == '}':
                    end = k; break
            break
    if end != -1:
        del lines[start:end + 1]
        open(dispatch_file, 'w').write('\n'.join(lines))
        print('  ✓ Removed misplaced block')
    else:
        print('  ⚠ Could not bound misplaced block; aborting'); raise SystemExit(1)
PYEOF
  fi

  DISPATCH_FILE="$DISPATCH_FILE" python3 - <<'PYEOF'
import sys, os

dispatch_file = os.environ['DISPATCH_FILE']
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
    f'{indent}\tconsole.log(`[before_dispatch] session re-routed to: ${{acpDispatchSessionKey}}`);\n'
    f'{indent}}}'
)
lines.insert(insert_idx, routing_code)

with open(dispatch_file, 'w') as f:
    f.write('\n'.join(lines))
print('  ✓ Dispatch patched')
PYEOF
  # Syntax-check the patched dispatch file; restore backup on failure.
  if ! node -c "$DISPATCH_FILE" 2>/tmp/dispatch-syntax.err; then
    echo "  ✗ Patched dispatch failed syntax check — restoring backup:"
    sed 's/^/      /' /tmp/dispatch-syntax.err
    cp "${DISPATCH_FILE}.bak" "$DISPATCH_FILE"
    exit 1
  fi
  echo "  ✓ Dispatch syntax OK"
fi

# --- Patch 1b: dispatch — pass quoted/reply content into before_dispatch event ---
# topic-router routes a Feishu reply into the quoted message's topic by reading
# the `📌 话题:` footer out of the quoted text. But the gateway builds the
# before_dispatch event with only 7 fields (content/body/channel/sessionKey/
# senderId/isGroup/timestamp) and drops the quoted body — so the router's
# `event.quotedContent` is always empty and a reply gets re-classified as new.
# The quoted body IS on the canonical ctx as `ctx.ReplyToBody` (set in the lark
# adapter's buildInboundPayload via replyToBody: params.quotedContent). Inject it
# as `quotedContent` on the event object literal. Safe degrade: undefined when no
# reply, which the router already treats as "no quote".
echo "[1b/3] Patching dispatch: inject quotedContent into before_dispatch event"
if grep -q "quotedContent: ctx.ReplyToBody" "$DISPATCH_FILE" 2>/dev/null; then
  echo "  Already patched. Skipping."
else
  cp "$DISPATCH_FILE" "${DISPATCH_FILE}.qbak"
  DISPATCH_FILE="$DISPATCH_FILE" python3 - <<'PYEOF'
import sys, os

dispatch_file = os.environ['DISPATCH_FILE']
lines = open(dispatch_file).read().split('\n')

# Anchor: the before_dispatch event object literal's first argument ends with
#   timestamp: hookContext.timestamp
# immediately followed by a line whose stripped form starts with `}, {` (the
# boundary between the event object and the context object). Insert our field
# right after the timestamp line, still inside the event object literal.
insert_idx = -1
for i, line in enumerate(lines):
    if 'timestamp: hookContext.timestamp' in line:
        nxt = lines[i + 1].strip() if i + 1 < len(lines) else ''
        if nxt.startswith('}, {'):
            insert_idx = i + 1
            break

if insert_idx == -1:
    print('ERROR: could not find before_dispatch event timestamp anchor')
    sys.exit(1)

# Derive indent from the timestamp line so the inserted field lines up.
anchor = lines[insert_idx - 1]
indent = anchor[:len(anchor) - len(anchor.lstrip())]
# The timestamp line had no trailing comma (it was the last field); add one.
lines[insert_idx - 1] = anchor.rstrip()
if not lines[insert_idx - 1].rstrip().endswith(','):
    lines[insert_idx - 1] = lines[insert_idx - 1] + ','
lines.insert(insert_idx, f'{indent}quotedContent: ctx.ReplyToBody')

with open(dispatch_file, 'w') as f:
    f.write('\n'.join(lines))
print('  ✓ quotedContent injected into before_dispatch event')
PYEOF
  if ! node -c "$DISPATCH_FILE" 2>/tmp/dispatch-1b-syntax.err; then
    echo "  ✗ Patched dispatch failed syntax check — restoring backup:"
    sed 's/^/      /' /tmp/dispatch-1b-syntax.err
    cp "${DISPATCH_FILE}.qbak" "$DISPATCH_FILE"
    exit 1
  fi
  echo "  ✓ Dispatch (1b) syntax OK"
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
  HOOK_FILE="$HOOK_FILE" python3 - <<'PYEOF'
import sys, os

hook_file = os.environ['HOOK_FILE']
with open(hook_file, 'r') as f:
    content = f.read()

# Find: 'if (handlerResult?.handled) return handlerResult;'
# Add after it: 'if (hookName === "before_dispatch" && handlerResult?.sessionKey) return handlerResult;'

old = 'if (handlerResult?.handled) return handlerResult;'
new = '''if (handlerResult?.handled) return handlerResult;
\t\t\tif (hookName === "before_dispatch" && handlerResult?.sessionKey) return handlerResult;'''

if old not in content:
    print('ERROR: Cannot find hook pattern in hook-runner')
    sys.exit(1)

# Only replace the first occurrence (in runClaimingHooksList)
content = content.replace(old, new, 1)

with open(hook_file, 'w') as f:
    f.write(content)
print('  ✓ Hook-runner patched')
PYEOF
fi

# --- Verify ---
echo ""
echo "=== Verification ==="
grep -q "session re-routed" "$DISPATCH_FILE" && echo "  ✓ Dispatch: routing code present" || echo "  ✗ Dispatch: MISSING"
grep -q "quotedContent: ctx.ReplyToBody" "$DISPATCH_FILE" && echo "  ✓ Dispatch: quotedContent injection present" || echo "  ✗ Dispatch: quotedContent MISSING"
grep -q "before_dispatch.*sessionKey" "$HOOK_FILE" && echo "  ✓ Hook-runner: sessionKey passthrough present" || echo "  ✗ Hook-runner: MISSING"
echo ""
echo "=== Done! Restart gateway to apply. ==="
