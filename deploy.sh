#!/bin/bash
# One-click deploy for topic-router on any OpenClaw container.
# Handles fresh containers, existing installs, network issues, missing tools.
#
# Usage (paste this single line into any container):
#   curl -fsSL https://raw.githubusercontent.com/FlanTHU/claude-code-worker/v2-direct-llm/deploy.sh | bash
#
# Or if curl is unavailable:
#   wget -qO- https://raw.githubusercontent.com/FlanTHU/claude-code-worker/v2-direct-llm/deploy.sh | bash
#
# Or manually:
#   bash deploy.sh

set -e

REPO_URL="https://github.com/FlanTHU/claude-code-worker.git"
REPO_DIR="/root/.openclaw/workspace/code-repo"
BRANCH="v2-direct-llm"

echo "╔══════════════════════════════════════════════╗"
echo "║   Topic Router — One-Click Deploy            ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Preflight checks ──
echo "[preflight] Checking environment..."

fail() { echo "ERROR: $1"; exit 1; }
warn() { echo "  ⚠️  $1"; }

# Check git
if ! command -v git &>/dev/null; then
  echo "  git not found, installing..."
  apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1 \
    || yum install -y git >/dev/null 2>&1 \
    || fail "Cannot install git. Install manually and retry."
fi
echo "  ✓ git $(git --version | cut -d' ' -f3)"

# Check python3
if ! command -v python3 &>/dev/null; then
  echo "  python3 not found, installing..."
  apt-get update -qq && apt-get install -y -qq python3 >/dev/null 2>&1 \
    || yum install -y python3 >/dev/null 2>&1 \
    || fail "Cannot install python3. Install manually and retry."
fi
echo "  ✓ python3"

# Check OpenClaw gateway
if [ ! -d "/app/dist" ]; then
  fail "/app/dist not found. Is this an OpenClaw container?"
fi
echo "  ✓ /app/dist exists"

# Check node user (used by gateway)
if ! id node &>/dev/null; then
  warn "User 'node' not found. Gateway will run as current user."
  RUN_AS_CURRENT=1
fi

# Check runuser
if ! command -v runuser &>/dev/null; then
  warn "runuser not available. Gateway will run as current user."
  RUN_AS_CURRENT=1
fi

echo ""

# ── Step 1: Get code ──
echo "[1/3] Getting code..."
git config --global http.sslVerify false 2>/dev/null || true
git config --global --add safe.directory "$REPO_DIR" 2>/dev/null || true

if [ -d "$REPO_DIR/.git" ]; then
  cd "$REPO_DIR"
  echo "  Repo exists, updating..."
  if ! timeout 15 git fetch origin "$BRANCH" --force 2>/dev/null; then
    warn "git fetch failed/timed out, using local code"
  else
    git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH" 2>/dev/null || true
    git reset --hard "origin/$BRANCH" 2>/dev/null || true
  fi
else
  echo "  Fresh install, cloning..."
  mkdir -p "$(dirname "$REPO_DIR")"
  if ! timeout 60 git clone -b "$BRANCH" "$REPO_URL" "$REPO_DIR" 2>&1; then
    fail "git clone failed. Check network connectivity to github.com"
  fi
  cd "$REPO_DIR"
fi

echo "  HEAD: $(git log --oneline -1)"

# Verify dist exists
if [ ! -d "$REPO_DIR/dist" ]; then
  fail "$REPO_DIR/dist not found. Repo may be incomplete."
fi
echo ""

# ── Step 2: Run bootstrap ──
echo "[2/3] Running bootstrap..."
export FORCE_BOOTSTRAP=1

# Override gateway run command if node user/runuser unavailable
if [ "${RUN_AS_CURRENT:-}" = "1" ]; then
  export GW_RUN_CMD="direct"
fi

bash "$REPO_DIR/bootstrap.sh"

echo ""
echo "[3/3] Done!"
echo ""
echo "  Test: send a message in Feishu, check /tmp/gw.log for [topic-router] lines"
echo "  Commands: /topics | /switch <label> | /newtopic <label> | /end | /endall"
