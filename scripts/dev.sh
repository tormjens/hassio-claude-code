#!/usr/bin/env bash
# ==============================================================================
# Local development for the Claude for Home Assistant add-on, without Docker.
#
# Starts two processes and stops both on Ctrl+C:
#   server  claude-ha/server  tsx watch (auto-restart on change)  :8099
#   ui      claude-ha/ui      vite dev server (HMR)               :5173
#
# Vite proxies /api and /ws to the server, so open http://localhost:5173.
#
# Usage:
#   scripts/dev.sh                 start server and UI
#   scripts/dev.sh --server-only   start only the server
#   scripts/dev.sh --ui-only       start only the Vite dev server
#   scripts/dev.sh --install       force `npm ci` in both packages first
#
# Configuration is read from the environment, with a `.env` file in the repo
# root loaded first if present (it is gitignored). Useful variables:
#   ANTHROPIC_API_KEY        or CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN
#   ANTHROPIC_BASE_URL       optional gateway
#   CLAUDE_HA_MODEL          optional model override
#   CLAUDE_HA_CONFIG_DIR     a Home Assistant config dir to edit
#                            (default: .dev/config, created with a stub)
#   CLAUDE_HA_DATA_DIR       where sessions and the audit log go
#                            (default: .dev/data)
#   CLAUDE_HA_LOG_LEVEL      debug | info | warning | error (default: debug)
#   SUPERVISOR_URL / SUPERVISOR_TOKEN
#                            only meaningful when pointed at a real Supervisor;
#                            without them the HA tools return errors, which is
#                            fine for UI and agent-loop work.
# ==============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/claude-ha/server"
UI_DIR="$ROOT/claude-ha/ui"
DEV_DIR="$ROOT/.dev"

RUN_SERVER=1
RUN_UI=1
FORCE_INSTALL=0

for arg in "$@"; do
  case "$arg" in
    --server-only) RUN_UI=0 ;;
    --ui-only)     RUN_SERVER=0 ;;
    --install)     FORCE_INSTALL=1 ;;
    -h|--help)     sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;36m[dev]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[dev]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[dev]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- .env ---------------------------------------------------------------------
if [[ -f "$ROOT/.env" ]]; then
  log "Loading $ROOT/.env"
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

# ---- toolchain ----------------------------------------------------------------
command -v node >/dev/null || die "node is not installed (need Node 22 or newer)"
command -v npm  >/dev/null || die "npm is not installed"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || die "Node 22 or newer is required, found $(node --version)"

install_deps() {
  local dir="$1"
  if [[ "$FORCE_INSTALL" == 1 || ! -d "$dir/node_modules" || "$dir/package-lock.json" -nt "$dir/node_modules" ]]; then
    log "Installing dependencies in ${dir#"$ROOT"/}"
    (cd "$dir" && npm ci)
  fi
}
[[ "$RUN_SERVER" == 1 ]] && install_deps "$SERVER_DIR"
[[ "$RUN_UI" == 1 ]]     && install_deps "$UI_DIR"

# ---- server environment -------------------------------------------------------
export CLAUDE_HA_PORT="${CLAUDE_HA_PORT:-8099}"
export CLAUDE_HA_LOG_LEVEL="${CLAUDE_HA_LOG_LEVEL:-debug}"
export CLAUDE_HA_DATA_DIR="${CLAUDE_HA_DATA_DIR:-$DEV_DIR/data}"
export CLAUDE_HA_CONFIG_DIR="${CLAUDE_HA_CONFIG_DIR:-$DEV_DIR/config}"
# Lets the server serve a built UI on :8099 too, if `npm run build` was run in ui/.
export CLAUDE_HA_PUBLIC_DIR="${CLAUDE_HA_PUBLIC_DIR:-$UI_DIR/dist}"
# Keep Claude Code state out of the real ~/.claude while developing.
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$DEV_DIR/claude}"
export DISABLE_AUTOUPDATER=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

mkdir -p "$CLAUDE_HA_DATA_DIR" "$CLAUDE_CONFIG_DIR"

# A stub Home Assistant config dir so the file tools and the git checkpoint
# hook have something real to work on. Only created when the default is used.
if [[ "$CLAUDE_HA_CONFIG_DIR" == "$DEV_DIR/config" && ! -d "$CLAUDE_HA_CONFIG_DIR" ]]; then
  log "Creating stub Home Assistant config in .dev/config"
  mkdir -p "$CLAUDE_HA_CONFIG_DIR"
  cat > "$CLAUDE_HA_CONFIG_DIR/configuration.yaml" <<'YAML'
# Stub config for local development of the Claude add-on.
default_config:

automation: !include automations.yaml
script: !include scripts.yaml
scene: !include scenes.yaml
YAML
  echo '[]' > "$CLAUDE_HA_CONFIG_DIR/automations.yaml"
  echo '{}' > "$CLAUDE_HA_CONFIG_DIR/scripts.yaml"
  echo '[]' > "$CLAUDE_HA_CONFIG_DIR/scenes.yaml"
  cat > "$CLAUDE_HA_CONFIG_DIR/secrets.yaml" <<'YAML'
# The secrets guard should refuse to read this file.
example_password: not-a-real-secret
YAML
  if command -v git >/dev/null; then
    (cd "$CLAUDE_HA_CONFIG_DIR" && git init -q && git add -A && git -c user.name=dev -c user.email=dev@localhost commit -qm "Initial stub config")
  fi
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -z "${ANTHROPIC_AUTH_TOKEN:-}" && -z "${ANTHROPIC_BASE_URL:-}" ]]; then
  warn "No credential found: the UI will load but chat will fail with 'Not signed in'."
  warn "Get a subscription token with:  claude setup-token"
  warn "then add it to $ROOT/.env :        CLAUDE_CODE_OAUTH_TOKEN=<token>"
  warn "or use an API key instead:         ANTHROPIC_API_KEY=<key>  (with CLAUDE_HA_AUTH_METHOD=api_key)"
fi
if [[ -z "${SUPERVISOR_TOKEN:-}" ]]; then
  warn "SUPERVISOR_TOKEN not set: Home Assistant tools will return errors (expected outside the add-on)."
fi

# ---- process management -------------------------------------------------------
PIDS=()

kill_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  trap - INT TERM EXIT
  log "Stopping..."
  for pid in "${PIDS[@]:-}"; do [[ -n "$pid" ]] && kill_tree "$pid"; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Run a command in `dir`, prefixing every output line with a coloured name.
# (A read loop instead of `sed -u`, which BSD sed on macOS lacks.)
start() {
  local name="$1" color="$2" dir="$3"; shift 3
  (
    cd "$dir"
    "$@" 2>&1 | while IFS= read -r line; do
      printf '\033[%sm[%s]\033[0m %s\n' "$color" "$name" "$line"
    done
  ) &
  PIDS+=("$!")
}

if [[ "$RUN_SERVER" == 1 ]]; then
  log "Server: http://localhost:$CLAUDE_HA_PORT  (config: $CLAUDE_HA_CONFIG_DIR, data: $CLAUDE_HA_DATA_DIR)"
  start server "1;32" "$SERVER_DIR" npm run dev --silent
fi
if [[ "$RUN_UI" == 1 ]]; then
  log "UI:     http://localhost:5173  (proxies /api and /ws to :$CLAUDE_HA_PORT)"
  start ui "1;35" "$UI_DIR" npm run dev --silent -- --port 5173 --strictPort
fi

log "Press Ctrl+C to stop."
# Exit when the first child exits so a crash is not silently hidden.
# (Polling instead of `wait -n`, which macOS's bash 3.2 lacks.)
while :; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      warn "A process exited; shutting down the rest."
      exit 1
    fi
  done
  sleep 1
done
