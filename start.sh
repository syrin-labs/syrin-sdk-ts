#!/usr/bin/env bash
# syrin-sdk-ts/start.sh
#
# Runs TypeScript SDK examples against the Syrin backend.
# Set SYRIN_API_KEY and OPENAI_API_KEY in examples/.env before running.
#
# Usage:
#   ./start.sh                              # run agent-server (the full demo)
#   ./start.sh --example basic-instrumentation
#   ./start.sh --example remote-config
#   ./start.sh --example agent-server       # default
#   ./start.sh --tests                      # run test suite

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Colours ──────────────────────────────────────────────────────────────────
BOLD="\033[1m"; CYAN="\033[36m"; GREEN="\033[32m"
YELLOW="\033[33m"; DIM="\033[2m"; RED="\033[31m"; RESET="\033[0m"

info()    { echo -e "${CYAN}▶${RESET}  $1"; }
success() { echo -e "${GREEN}✓${RESET}  $1"; }
warn()    { echo -e "${YELLOW}!${RESET}  $1"; }
err()     { echo -e "${RED}✗${RESET}  $1" >&2; }

# ── Load examples/.env ────────────────────────────────────────────────────────
load_env() {
  local envfile="$SCRIPT_DIR/examples/.env"
  if [[ -f "$envfile" ]]; then
    info "Loading $envfile"
    set -o allexport
    # shellcheck disable=SC1090
    source "$envfile"
    set +o allexport
  else
    warn "examples/.env not found — create it with SYRIN_API_KEY and OPENAI_API_KEY"
  fi
}

# ── Ensure node_modules ───────────────────────────────────────────────────────
ensure_deps() {
  if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
    info "Installing npm dependencies…"
    (cd "$SCRIPT_DIR" && npm install --silent)
    success "Dependencies installed"
  fi
}

# ── Run example ───────────────────────────────────────────────────────────────
run_example() {
  local name="${1:-agent-server}"
  local file="$SCRIPT_DIR/examples/${name}.ts"

  if [[ ! -f "$file" ]]; then
    err "Example not found: $file"
    echo "Available examples:"
    ls "$SCRIPT_DIR/examples/"*.ts 2>/dev/null | xargs -n1 basename | sed 's/\.ts$//'
    exit 1
  fi

  # Verify required env vars are set
  if [[ -z "${SYRIN_API_KEY:-}" ]]; then
    err "SYRIN_API_KEY is not set. Add it to examples/.env or export it."
    exit 1
  fi

  export SYRIN_BACKEND_URL="${SYRIN_BACKEND_URL:-http://localhost:4000}"

  echo ""
  echo -e "${BOLD}Running: ${name}.ts${RESET}"
  echo -e "${DIM}  Backend: $SYRIN_BACKEND_URL${RESET}"
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
EXAMPLE_NAME="agent-openai"
RUN_TESTS=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --example|-e) shift; EXAMPLE_NAME="$1" ;;
    --tests|-t)   RUN_TESTS=true ;;
    --help|-h)
      echo "Usage: $0 [--example NAME] [--tests]"
      echo ""
      echo "Agent examples (each runs a separate HTTP server):"
      echo "  --example agent-openai      OpenAI SDK         port 8001 (default)"
      echo "  --example agent-anthropic   Anthropic SDK      port 8002"
      echo "  --example agent-langchain   LangChain          port 8003"
      echo "  --example agent-langgraph   LangGraph          port 8004"
      echo "  --example agent-mastra      Mastra             port 8005"
      echo "  --example agent-vercel      Vercel AI SDK      port 8006"
      echo ""
      echo "Other examples:"
      echo "  --example basic-instrumentation   minimal OpenAI instrumentation"
      echo "  --example remote-config           remote config demo"
      echo ""
      echo "  --tests                           run the test suite"
      exit 0 ;;
    *) warn "Unknown flag: $1" ;;
  esac
  shift
done

# ── Main ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "┌──────────────────────────────────────────────────────────┐"
echo -e "│  ${BOLD}Syrin SDK — TypeScript${RESET}                                   │"
echo -e "└──────────────────────────────────────────────────────────┘"
echo ""

load_env
ensure_deps

if $RUN_TESTS; then
  run_tests
  exit 0
fi

run_example "$EXAMPLE_NAME"

echo ""
success "Done."
