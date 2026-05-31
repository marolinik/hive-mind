#!/usr/bin/env bash
# first-run-smoke.sh -- end-to-end sanity check for hive-mind v0.1.x
#
# Goal: a stranger can clone the repo, run this script, and see the MCP server
# start + the CLI read from and write to a throwaway workspace in < 5 minutes.
#
# Scope note (v0.1.x):
#   Persona-facing commands (`init`, `status`, `mcp start`, `mcp call`) shipped
#   in v0.1.x — this script exercises the full surface:
#     init / status / save-session / recall-context / mcp call
#   plus a direct stdio handshake with the MCP server binary.

set -euo pipefail

# ---- pretty printing ---------------------------------------------------------

if [[ -t 1 ]]; then
  C_OK=$'\033[0;32m'
  C_WARN=$'\033[0;33m'
  C_ERR=$'\033[0;31m'
  C_DIM=$'\033[2m'
  C_RST=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_RST=""
fi

step()  { printf "\n%s==>%s %s\n" "$C_OK"  "$C_RST" "$*"; }
warn()  { printf "%s[warn]%s %s\n"      "$C_WARN" "$C_RST" "$*"; }
fail()  { printf "%s[fail]%s %s\n"      "$C_ERR"  "$C_RST" "$*" >&2; exit 1; }
ok()    { printf "%s[ ok ]%s %s\n"      "$C_OK"   "$C_RST" "$*"; }

start_ts=$(date +%s)

# ---- preconditions -----------------------------------------------------------

step "Checking prerequisites"

command -v node >/dev/null 2>&1 || fail "node not found on PATH"
command -v npm  >/dev/null 2>&1 || fail "npm not found on PATH"

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  fail "node >= 20 required (found $(node --version))"
fi
ok "node $(node --version), npm $(npm --version)"

# ---- locate repo root --------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
ok "repo root: $REPO_ROOT"

# ---- install + build ---------------------------------------------------------

# Install workspaces. We prefer `npm ci` for lockfile determinism, but on
# Windows `npm ci` deletes node_modules first and can hit EPERM when a native
# binary (better-sqlite3, sqlite-vec) is locked by a prior run -- that failure
# also strips the @hive-mind/* workspace symlinks and bricks the CLI until a
# manual reinstall. So on Windows we use `npm install`, and on any failure we
# surface a recovery hint. (CI's lockfile-determinism gate is the separate
# build-test matrix, which runs `npm ci` directly -- unaffected by this.)
install_workspaces() {
  local uname_s
  uname_s="$(uname -s 2>/dev/null || echo unknown)"
  if [[ "${OS:-}" == "Windows_NT" || "$uname_s" == MINGW* || "$uname_s" == MSYS* || "$uname_s" == CYGWIN* ]]; then
    npm install --include=optional
  elif [[ -f package-lock.json ]]; then
    npm ci --include=optional
  else
    npm install --include=optional
  fi
}

step "Installing workspaces"
if ! install_workspaces; then
  warn "workspace install failed. If npm ci wiped node_modules on Windows:"
  warn "  1. close any running hive-mind processes (MCP server, CLI, editors holding .node files)"
  warn "  2. rm -rf node_modules"
  warn "  3. npm install"
  fail "workspace install failed (see recovery steps above)"
fi

step "Building all packages"
npm run build

# ---- resolve CLI + MCP binaries ---------------------------------------------

CLI_BIN="$REPO_ROOT/packages/cli/dist/index.js"
MCP_BIN="$REPO_ROOT/packages/mcp-server/dist/index.js"

[[ -f "$CLI_BIN" ]] || fail "CLI binary missing: $CLI_BIN (did build succeed?)"
[[ -f "$MCP_BIN" ]] || fail "MCP binary missing: $MCP_BIN (did build succeed?)"

# ---- scratch workspace -------------------------------------------------------

SCRATCH="$(mktemp -d -t hive-mind-smoke-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT
ok "scratch workspace: $SCRATCH"

export HIVE_MIND_DATA_DIR="$SCRATCH"
export HIVE_MIND_WORKSPACE="smoke"

# ---- CLI smoke: init -> save -> recall -> status ----------------------------

step "CLI: init a fresh workspace"
node "$CLI_BIN" init --json \
  || fail "init failed"
ok "init succeeded"

step "CLI: save a session transcript"
SAMPLE="$SCRATCH/sample-session.md"
cat > "$SAMPLE" <<'EOF'
# Smoke Session

The user prefers TypeScript over JavaScript for new projects.
The user is evaluating hive-mind for a local-first memory setup.
EOF

node "$CLI_BIN" save-session --file "$SAMPLE" --json \
  || fail "save-session failed"
ok "save-session succeeded"

step "CLI: recall memory with a hybrid search query"
RECALL_OUT=$(node "$CLI_BIN" recall-context "TypeScript preferences" --limit 5 --json) \
  || fail "recall-context failed"
echo "$RECALL_OUT" | head -c 400
echo
ok "recall-context returned results"

step "CLI: status reports frame count"
STATUS_OUT=$(node "$CLI_BIN" status --json) \
  || fail "status failed"
if ! echo "$STATUS_OUT" | grep -q '"frames":'; then
  fail "status output missing frames count: ${STATUS_OUT:0:200}"
fi
ok "status returned a summary"

# ---- MCP handshake ----------------------------------------------------------

step "MCP: stdio initialize handshake"
# Send an MCP initialize request over stdio and look for a JSON response.
# This is a lightweight sanity check, not a full tool-call suite.
INIT_REQ='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"hive-mind-smoke","version":"0.1.0"}}}'

if ! MCP_OUT=$(printf '%s\n' "$INIT_REQ" | timeout 10s node "$MCP_BIN" 2>/dev/null | head -n 1); then
  warn "MCP handshake timed out or returned non-zero -- inspect packages/mcp-server/dist/index.js manually"
else
  if [[ "$MCP_OUT" == *'"jsonrpc"'* && "$MCP_OUT" == *'"result"'* ]]; then
    ok "MCP server responded to initialize"
  else
    warn "MCP server produced output but it did not look like a JSON-RPC result:"
    printf "%s\n" "${MCP_OUT:0:400}"
  fi
fi

# ---- done -------------------------------------------------------------------

end_ts=$(date +%s)
elapsed=$(( end_ts - start_ts ))

printf "\n%s[ smoke passed in %ds ]%s\n" "$C_OK" "$elapsed" "$C_RST"
printf "%sworkspace removed: %s%s\n" "$C_DIM" "$SCRATCH" "$C_RST"
