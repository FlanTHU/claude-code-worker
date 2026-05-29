#!/bin/bash
# Patch gateway dispatch file to support before_dispatch sessionKey routing.
# Run inside the container: bash /root/.openclaw/workspace/code-repo/openclaw-topic-router/patch-gateway.sh
set -e

DISPATCH_FILE=$(ls /app/dist/dispatch-[A-Za-z0-9_-]*.js 2>/dev/null | grep -v "acp\|result" | head -1)

if [ -z "$DISPATCH_FILE" ]; then
  echo "ERROR: Cannot find dispatch file in /app/dist/"
  exit 1
fi

echo "Patching: $DISPATCH_FILE"

# Check if already patched
if grep -q "session re-routed to" "$DISPATCH_FILE" 2>/dev/null; then
  echo "Already patched. Skipping."
  exit 0
fi

# Backup
cp "$DISPATCH_FILE" "${DISPATCH_FILE}.bak"

# Apply all changes via Python (avoids sed portability issues)
python3 << 'PYEOF'
import sys, os

dispatch_file = os.environ.get("DISPATCH_FILE") or sys.argv[1] if len(sys.argv) > 1 else None
if not dispatch_file:
    # Find it ourselves
    import glob
    candidates = [f for f in glob.glob("/app/dist/dispatch-*.js") if "acp" not in f and "result" not in f]
    if not candidates:
        print("ERROR: no dispatch file found")
        sys.exit(1)
    dispatch_file = candidates[0]

with open(dispatch_file, "r") as f:
    content = f.read()

# Step 1: const → let
replacements = [
    ("const acpDispatchSessionKey", "let acpDispatchSessionKey"),
    ("const sessionStoreEntry", "let sessionStoreEntry"),
    ("const sessionAgentId", "let sessionAgentId"),
    ("const sessionAgentCfg", "let sessionAgentCfg"),
]
for old, new in replacements:
    if old in content:
        content = content.replace(old, new, 1)
        print(f"  ✓ {old} → {new}")
    else:
        print(f"  - {old} not found (may already be let)")

# Step 2: Find insertion point and add routing code
lines = content.split("\n")
insert_idx = -1
found_marker = False

for i, line in enumerate(lines):
    if "before_dispatch_handled" in line and "recordProcessed" in line:
        found_marker = True
        continue
    if found_marker and "return attachSourceReplyDeliveryMode" in line:
        # Count braces from the return line forward to find where the if-block closes
        brace_count = 0
        started = False
        for j in range(i, min(i + 10, len(lines))):
            for ch in lines[j]:
                if ch == "{":
                    brace_count += 1
                elif ch == "}":
                    brace_count -= 1
            if "attachSourceReplyDeliveryMode" in lines[j]:
                started = True
            if started and brace_count <= -1:
                insert_idx = j + 1
                break
        if insert_idx == -1:
            for j in range(i + 1, min(i + 10, len(lines))):
                if lines[j].strip() == "}":
                    insert_idx = j + 1
                    break
        break

if insert_idx == -1:
    print("ERROR: Could not find insertion point for session routing code")
    sys.exit(1)

indent = "\t\t\t\t"
routing_code = (
    f'{indent}if (beforeDispatchResult?.sessionKey && beforeDispatchResult.sessionKey !== acpDispatchSessionKey) {{\n'
    f'{indent}\tacpDispatchSessionKey = beforeDispatchResult.sessionKey;\n'
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

with open(dispatch_file, "w") as f:
    f.write("\n".join(lines))

print(f"  ✓ Inserted session routing code at line {insert_idx}")
print("\n=== ✓ Gateway patch applied successfully! ===")
PYEOF

# Verify
if grep -q "session re-routed to" "$DISPATCH_FILE"; then
  echo ""
  echo "Verification:"
  grep -n "session re-routed" "$DISPATCH_FILE" | head -1
  echo ""
  echo "Next step: restart gateway"
  echo "  pkill -9 -f openclaw; sleep 2; runuser -u node -- /tmp/sg.sh &>/tmp/gw.log &"
else
  echo "ERROR: Patch verification failed!"
  echo "Restoring backup..."
  cp "${DISPATCH_FILE}.bak" "$DISPATCH_FILE"
  exit 1
fi
