#!/bin/bash
# One-click deploy for topic-router on any OpenClaw container.
# Handles fresh containers, existing installs, network issues, missing tools.
#
# Usage (paste this single line into any container):
#   curl -fsSL https://raw.githubusercontent.com/FlanTHU/claude-code-worker/main/deploy.sh | bash
#
# Or if curl is unavailable:
#   wget -qO- https://raw.githubusercontent.com/FlanTHU/claude-code-worker/main/deploy.sh | bash
#
# Or manually:
#   bash deploy.sh

set -e

REPO_URL="${REPO_URL:-https://github.com/FlanTHU/claude-code-worker.git}"
REPO_DIR="${REPO_DIR:-/root/.openclaw/workspace/code-repo}"
BRANCH="${BRANCH:-main}"

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

# Derive tarball URL from REPO_URL (only works for GitHub)
TARBALL_URL="${REPO_URL%.git}/archive/refs/heads/${BRANCH}.tar.gz"

fetch_via_tarball() {
  echo "  Trying tarball download..."
  local tmp="/tmp/topic-router-$$.tar.gz"
  local extract="/tmp/topic-router-extract-$$"
  if curl -fsSL --connect-timeout 10 -o "$tmp" "$TARBALL_URL" 2>/dev/null \
     || wget -q --timeout=10 -O "$tmp" "$TARBALL_URL" 2>/dev/null; then
    # Extract to a temp dir and overlay onto REPO_DIR. The old `rm -rf "$REPO_DIR"`
    # destroyed the git repo (→ "HEAD: tarball (no git history)"), and if the
    # caller's shell was cwd'd inside REPO_DIR it also triggered "getcwd: cannot
    # access parent directories". Worse, once .git was gone every later `git fetch`
    # failed and fell back to tarball again — a self-perpetuating loop. Overlaying
    # keeps an existing .git intact; if there's none yet (fresh container) we init
    # one below. Either way the result is a working git repo for redeploy/git fetch.
    rm -rf "$extract"; mkdir -p "$extract"
    if ! tar xzf "$tmp" -C "$extract" --strip-components=1 2>/dev/null; then
      rm -rf "$tmp" "$extract"; return 1
    fi
    mkdir -p "$REPO_DIR"
    if command -v rsync >/dev/null 2>&1; then
      # Copy everything except .git; don't delete extra files (keep state dirs etc).
      rsync -a --exclude='.git' "$extract"/ "$REPO_DIR"/
    else
      # No rsync: tarball has no .git so cp -a won't clobber REPO_DIR/.git.
      cp -a "$extract"/. "$REPO_DIR"/ 2>/dev/null
    fi
    rm -rf "$tmp" "$extract"
    # The tarball has no .git. If REPO_DIR isn't a git repo yet (fresh container,
    # or an earlier destructive run wiped it), initialize one and wire up the
    # remote, so a later `git fetch`/redeploy.sh can work instead of being stuck
    # on tarball forever. Best-effort: a non-git fallback still runs, just without
    # incremental updates.
    if [ ! -d "$REPO_DIR/.git" ]; then
      ( cd "$REPO_DIR" \
        && git init -q 2>/dev/null \
        && git remote add origin "$REPO_URL" 2>/dev/null \
        && git config --add safe.directory "$REPO_DIR" 2>/dev/null ) || true
      echo "  ✓ Downloaded via tarball (initialized git repo for future updates)"
    else
      echo "  ✓ Downloaded via tarball (preserved existing .git)"
    fi
    return 0
  fi
  rm -f "$tmp"; rm -rf "$extract"
  return 1
}

if [ -d "$REPO_DIR/.git" ]; then
  cd "$REPO_DIR"
  echo "  Repo exists, updating..."
  if ! timeout 15 git fetch origin "$BRANCH" --force 2>/dev/null; then
    warn "git fetch failed/timed out"
    if ! fetch_via_tarball; then
      warn "Tarball also failed, using local code"
    fi
  else
    git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH" 2>/dev/null || true
    git reset --hard "origin/$BRANCH" 2>/dev/null || true
  fi
elif [ -d "$REPO_DIR" ]; then
  # Directory exists but not a git repo (e.g. leftover from the old destructive
  # tarball path). Re-clone cleanly. cd out first so removing REPO_DIR can't strand
  # the shell's cwd ("getcwd: cannot access parent directories").
  echo "  Directory exists (no .git), re-cloning..."
  cd / 2>/dev/null || true
  rm -rf "$REPO_DIR"
  mkdir -p "$(dirname "$REPO_DIR")"
  if ! timeout 30 git clone -b "$BRANCH" "$REPO_URL" "$REPO_DIR" 2>/dev/null; then
    warn "git clone failed, trying tarball"
    if ! fetch_via_tarball; then
      fail "Cannot download code. Check network connectivity."
    fi
  fi
  cd "$REPO_DIR"
else
  echo "  Fresh install..."
  mkdir -p "$(dirname "$REPO_DIR")"
  if ! timeout 30 git clone -b "$BRANCH" "$REPO_URL" "$REPO_DIR" 2>/dev/null; then
    warn "git clone failed, trying tarball"
    if ! fetch_via_tarball; then
      fail "Cannot download code. Check network connectivity."
    fi
  fi
  cd "$REPO_DIR"
fi

echo "  HEAD: $(git log --oneline -1 2>/dev/null || echo 'tarball (no git history)')"

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
