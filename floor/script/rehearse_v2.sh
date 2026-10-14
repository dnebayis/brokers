#!/usr/bin/env bash
# The Floor v2 deploy, rehearsed on an anvil fork of Robinhood Chain mainnet: the real deploy
# script is broadcast onto the fork as the impersonated deployer, then test/ForkFloorV2.t.sol
# drives what it deployed (config, the live basket in three currencies, a name without a pool
# skipped and handed back, Playbooks moved onto v2 and run for a real Broker, the fee flush).
# Nothing reaches a real network.
#
#   cd floor && FORK_RPC=<metered mainnet url> bash script/rehearse_v2.sh
#
# After the real deploy, FLOOR_V2=<router address> skips the deploy step and drives the
# deployed router on the fork instead (the fork test moves Playbooks onto it on the fork only).
#
# FORK_RPC defaults to the public node (it drops old state within minutes, so the metered one
# is the reliable choice); RPC_ORIGIN (default https://www.coattail.cash) is sent with it.
set -euo pipefail
cd "$(dirname "$0")/.."
FORK="${FORK_RPC:-https://rpc.mainnet.chain.robinhood.com}"
ORIGIN="${RPC_ORIGIN:-https://www.coattail.cash}"
PORT="${ANVIL_PORT:-8562}"
RPC="http://127.0.0.1:${PORT}"
DEPLOYER=0x9e643731dc9D8795573Aa34C410664407FfDC440
OUT=rehearsal/floor-v2-fork.json
REPORT=rehearsal/floor-v2-rehearsal.md

anvil --fork-url "$FORK" --fork-header "Origin: ${ORIGIN}" --port "$PORT" --auto-impersonate --silent >/dev/null 2>&1 &
APID=$!
trap 'kill $APID 2>/dev/null || true' EXIT
for _ in $(seq 1 90); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
FORK_BLOCK=$(cast block-number --rpc-url "$RPC")
echo "fork of 4663 at block ${FORK_BLOCK}"
cast rpc anvil_setBalance "$DEPLOYER" 0xDE0B6B3A7640000 --rpc-url "$RPC" >/dev/null

if [ -n "${FLOOR_V2:-}" ]; then
  ROUTER="$FLOOR_V2"
  REPORT=rehearsal/floor-v2-deployed-check.md
  echo "step 0: checking the deployed router $ROUTER (nothing redeployed)"
  ROUTES=$(cast call "$ROUTER" 'VERSION()(string)' --rpc-url "$RPC")
  echo "  VERSION $ROUTES"
else
  echo "step 0: the mainnet deploy script, broadcast on the fork"
  FLOOR_OUT="$OUT" forge script script/DeployMainnetFloorV2.s.sol --rpc-url "$RPC" --broadcast \
    --unlocked --sender "$DEPLOYER" 2>&1 | grep -E "routes wired|skipped|Floor v2|Error" || true
  ROUTER=$(python3 -c "import json;print(json.load(open('$OUT'))['router'])")
  echo "deployed on the fork: $ROUTER"
fi

echo "step 1: drive it"
set +e
FLOOR_V2="$ROUTER" RH_RPC="$RPC" forge test --match-contract ForkFloorV2 -vv 2>&1 | tee rehearsal/.floor-v2-test.log \
  | grep -E "PASS|FAIL|Suite result"
STATUS=${PIPESTATUS[0]}
set -e

{
  echo "# The Floor v2, rehearsed on a mainnet fork"
  echo
  echo "_$(date -u '+%Y-%m-%d %H:%M UTC'), anvil fork of Robinhood Chain 4663 at block ${FORK_BLOCK};"
  echo "\`script/rehearse_v2.sh\`: \`DeployMainnetFloorV2.s.sol\` broadcast onto the fork as the deployer,"
  echo "then \`test/ForkFloorV2.t.sol\` against the router it deployed. Nothing was sent to a real network._"
  echo
  echo "Router: \`${ROUTER}\`$([ -n "${FLOOR_V2:-}" ] && echo " (the real deployment, driven on the fork)" || echo " (deployed on the fork by the script)")."
  echo
  echo "| test | result |"
  echo "|---|---|"
  grep -E "^\[(PASS|FAIL)" rehearsal/.floor-v2-test.log | sed -E 's/^\[(PASS|FAIL)[^]]*\] ([^ ]+).*/| \2 | \1 |/'
  echo
  grep -E "Suite result" rehearsal/.floor-v2-test.log | sed 's/^/    /'
} > "$REPORT"
rm -f rehearsal/.floor-v2-test.log
echo "report -> $REPORT"
exit "$STATUS"
