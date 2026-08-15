#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"

if [[ -f "$ROOT_DIR/frontend/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/frontend/.env.local"
  set +a
fi

UPSTREAM_RPC="${RH_RPC_URL:-${NEXT_PUBLIC_RPC_URL_MAINNET:-}}"
if [[ -z "$UPSTREAM_RPC" ]]; then
  echo "Missing RH_RPC_URL or NEXT_PUBLIC_RPC_URL_MAINNET" >&2
  exit 1
fi

PROXY_PORT="${RH_PROXY_PORT:-18545}"
export RH_UPSTREAM_RPC="$UPSTREAM_RPC"
export RH_RPC_ORIGIN="${RH_RPC_ORIGIN:-http://localhost:3000}"
export RH_PROXY_PORT="$PROXY_PORT"

python3 "$CONTRACTS_DIR/scripts/rpc_origin_proxy.py" &
PROXY_PID=$!
cleanup() {
  kill "$PROXY_PID" 2>/dev/null || true
  wait "$PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in {1..50}; do
  if cast chain-id --rpc-url "http://127.0.0.1:$PROXY_PORT" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if [[ "$(cast chain-id --rpc-url "http://127.0.0.1:$PROXY_PORT")" != "4663" ]]; then
  echo "Private RPC is not Robinhood Chain mainnet (4663)" >&2
  exit 1
fi

cd "$CONTRACTS_DIR"
REQUIRE_MAINNET_FORK=true forge test \
  --fork-url "http://127.0.0.1:$PROXY_PORT" \
  "$@"
