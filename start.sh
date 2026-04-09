#!/usr/bin/env bash
# syrin-sdk-ts/start.sh
# Starts the mock backend and runs TypeScript SDK examples.
#
# Usage:
#   ./start.sh                   # backend + example 03 (remote config)
#   ./start.sh --example 01      # run 01-basic-chat.ts
#   ./start.sh --example 04      # run 04-multi-agent.ts
#   ./start.sh --backend         # start backend only, keep it running
#   ./start.sh --tests           # run test suite

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/../mock-backend"
BACKEND_PORT="${SYRIN_BACKEND_PORT:-4318}"
BACKEND_PID=""

# ── Colours ──────────────────────────────────────────────────────────────────
BOLD="\033[1m"; CYAN="\033[36m"; GREEN="\033[32m"
YELLOW="\033[33m"; DIM="\033[2m"; RED="\033[31m"; RESET="\033[0m"

info()    { echo -e "${CYAN}▶${RESET}  $1"; }
success() { echo -e "${GREEN}✓${RESET}  $1"; }
warn()    { echo -e "${YELLOW}!${RESET}  $1"; }
err()     { echo -e "${RED}✗${RESET}  $1" >&2; }

# ── Load .env ────────────────────────────────────────────────────────────────
load_env() {
  local envfile="$SCRIPT_DIR/.env"
  if [[ -f "$envfile" ]]; then
    info "Loading $envfile"
    set -o allexport
    # shellcheck disable=SC1090
    source "$envfile"
    set +o allexport
  else
    warn ".env not found — set OPENAI_API_KEY manually or create $envfile"
  fi
}

# ── Cleanup ───────────────────────────────────────────────────────────────────
cleanup() {
  if [[ -n "$BACKEND_PID" ]]; then
    info "Stopping mock backend (PID $BACKEND_PID)…"
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ── Ensure node_modules ───────────────────────────────────────────────────────
ensure_deps() {
  if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
    info "Installing npm dependencies…"
    (cd "$SCRIPT_DIR" && npm install --silent)
    success "Dependencies installed"
  fi
}

# ── Find Python for backend ───────────────────────────────────────────────────
find_python() {
  # Prefer the sibling SDK's .venv, then fall back to system python3
  if [[ -x "$SCRIPT_DIR/../syrin-sdk-py/.venv/bin/python" ]]; then
    echo "$SCRIPT_DIR/../syrin-sdk-py/.venv/bin/python"
  elif command -v python3 &>/dev/null; then
    echo "python3"
  else
    echo ""
  fi
}

# ── Start mock backend ────────────────────────────────────────────────────────
start_backend() {
  if curl -sf "http://localhost:$BACKEND_PORT/health" >/dev/null 2>&1; then
    success "Mock backend already running on port $BACKEND_PORT"
    return
  fi

  local python
  python="$(find_python)"
  if [[ -z "$python" ]]; then
    err "Python not found — needed to run the mock backend"
    exit 1
  fi

  info "Starting mock backend on port $BACKEND_PORT…"

  if ! "$python" -c "import fastapi" &>/dev/null 2>&1; then
    info "Installing backend deps…"
    if command -v uv &>/dev/null; then
      uv pip install fastapi uvicorn --python "$python" --quiet
    else
      "$python" -m pip install fastapi uvicorn --quiet
    fi
  fi

  "$python" "$BACKEND_DIR/server.py" --port "$BACKEND_PORT" &
  BACKEND_PID=$!

  local attempts=0
  until curl -sf "http://localhost:$BACKEND_PORT/health" >/dev/null 2>&1; do
    sleep 0.4; attempts=$((attempts + 1))
    [[ $attempts -ge 25 ]] && { err "Backend did not start in time"; exit 1; }
  done
  success "Mock backend ready → ${CYAN}http://localhost:$BACKEND_PORT${RESET}"
  echo -e "  ${DIM}Swagger UI: http://localhost:$BACKEND_PORT/docs${RESET}"
}

# ── Run example ───────────────────────────────────────────────────────────────
run_example() {
  local num="${1:-03}"
  # zero-pad to 2 digits
  local padded
  padded=$(printf "%02d" "$num" 2>/dev/null || echo "$num")
  local pattern="$SCRIPT_DIR/examples/${padded}-*.ts"
  # shellcheck disable=SC2206
  local files=($pattern)
  local file="${files[0]:-}"

  if [[ -z "$file" || ! -f "$file" ]]; then
    err "No example matching: $pattern"
    echo "Available examples:"
    ls "$SCRIPT_DIR/examples/"
    exit 1
  fi

  export SYRIN_API_KEY="${SYRIN_API_KEY:-syrin_demo}"
  export SYRIN_BACKEND_URL="http://localhost:$BACKEND_PORT"

  echo ""
  echo -e "${BOLD}Running: $(basename "$file")${RESET}"
  echo -e "${DIM}─────────────────────────────────────────────────────${RESET}"
  (cd "$SCRIPT_DIR" && npx tsx "$file")
}

# ── Run tests ─────────────────────────────────────────────────────────────────
run_tests() {
  ensure_deps
  info "Running test suite…"
  (cd "$SCRIPT_DIR" && npm test)
}

# ── Parse args ────────────────────────────────────────────────────────────────
EXAMPLE_NUM="03"
BACKEND_ONLY=false
RUN_TESTS=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --example|-e) shift; EXAMPLE_NUM="$1" ;;
    --backend)    BACKEND_ONLY=true ;;
    --tests|-t)   RUN_TESTS=true ;;
    --help|-h)
      echo "Usage: $0 [--example NUM] [--backend] [--tests]"
      echo "  --example 01-04   run a specific example (default: 03)"
      echo "  --backend         start backend only, keep it running"
      echo "  --tests           run the test suite"
      exit 0 ;;
    *) warn "Unknown flag: $1" ;;
  esac
  shift
done

# ── Main ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "┌──────────────────────────────────────────────────────────┐"
echo -e "│  ${BOLD}SYRIN SDK — TypeScript${RESET}                                   │"
echo -e "└──────────────────────────────────────────────────────────┘"
echo ""

load_env
ensure_deps

if $RUN_TESTS; then
  run_tests
  exit 0
fi

start_backend

if $BACKEND_ONLY; then
  info "Backend running on port $BACKEND_PORT. Press Ctrl+C to stop."
  wait "$BACKEND_PID"
  exit 0
fi

run_example "$EXAMPLE_NUM"

echo ""
success "Done. Check the backend output above to see all /ingest traffic."
