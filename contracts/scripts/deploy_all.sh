#!/usr/bin/env bash
set -euo pipefail

# One release command, multiple on-chain transactions. Deploy.s.sol creates and wires the
# application contracts; LaunchWithHook.s.sol then mines/deploys the hook, creates the native
# ETH/COAT v4 pool, locks its LP NFT and wires the buyback burner. Mint remains closed.

: "${RH_RPC_URL:?RH_RPC_URL is required}"
: "${PRIVATE_KEY:?PRIVATE_KEY is required}"

deploy_chain_id="$(cast chain-id --rpc-url "$RH_RPC_URL")"
deploy_report_dir="reports/deployments"
mkdir -p "$deploy_report_dir"

if [[ "$deploy_chain_id" == "46630" ]]; then
  export WETH="${WETH:-0x7943e237c7F95DA44E0301572D358911207852Fa}"
fi

forge script --force script/Deploy.s.sol:Deploy --rpc-url "$RH_RPC_URL" --broadcast --slow

deploy_broadcast="broadcast/Deploy.s.sol/${deploy_chain_id}/run-latest.json"
test -f "$deploy_broadcast"

coat_address="$(jq -er '[.transactions[] | select(.contractName == "COAT")][-1].contractAddress' "$deploy_broadcast")"
fee_splitter_address="$(jq -er '[.transactions[] | select(.contractName == "FeeSplitter")][-1].contractAddress' "$deploy_broadcast")"
booster_address="$(jq -er '[.transactions[] | select(.contractName == "Booster")][-1].contractAddress' "$deploy_broadcast")"
stock_router_address="$(jq -er '[.transactions[] | select(.contractName == "StockRouter")][-1].contractAddress' "$deploy_broadcast")"
venue_report=""

if [[ "$deploy_chain_id" == "46630" ]]; then
  WETH="$WETH" \
  STOCK_ROUTER="$stock_router_address" BOOSTER="$booster_address" \
    forge script --force script/DeployTestnetVenue.s.sol:DeployTestnetVenue \
      --rpc-url "$RH_RPC_URL" --broadcast --slow
  venue_report="reports/testnet-venue-46630.json"
  test -f "$venue_report"
fi

COAT_ADDRESS="$coat_address" FEE_SPLITTER="$fee_splitter_address" \
  forge script --force script/LaunchWithHook.s.sol:LaunchWithHook --rpc-url "$RH_RPC_URL" --broadcast --slow

launch_broadcast="broadcast/LaunchWithHook.s.sol/${deploy_chain_id}/run-latest.json"
test -f "$launch_broadcast"
launch_report="reports/launch-${deploy_chain_id}.json"
test -f "$launch_report"

jq -n \
  --argjson chainId "$deploy_chain_id" \
  --arg deployBroadcast "$deploy_broadcast" \
  --arg launchBroadcast "$launch_broadcast" \
  --arg launchReport "$launch_report" \
  --arg coat "$coat_address" \
  --arg feeSplitter "$fee_splitter_address" \
  --arg venueReport "$venue_report" \
  --arg broker "$(jq -er '[.transactions[] | select(.contractName == "CoattailBroker")][-1].contractAddress' "$deploy_broadcast")" \
  --arg booster "$booster_address" \
  --arg stockRouter "$stock_router_address" \
  --arg renderer "$(jq -er '[.transactions[] | select(.contractName == "BrokerRenderer")][-1].contractAddress' "$deploy_broadcast")" \
  --arg atomicLauncher "$(jq -er '.atomicLauncher' "$launch_report")" \
  --arg feeHook "$(jq -er '.feeHook' "$launch_report")" \
  --arg lpLocker "$(jq -er '.lpLocker' "$launch_report")" \
  --arg router "$(jq -er '.router' "$launch_report")" \
  --arg buybackBurner "$(jq -er '.buybackBurner' "$launch_report")" \
  '{
    chainId: $chainId,
    mintOpen: false,
    poolPair: "native ETH/COAT",
    contracts: {
      broker: $broker,
      coat: $coat,
      booster: $booster,
      stockRouter: $stockRouter,
      feeSplitter: $feeSplitter,
      renderer: $renderer,
      atomicLauncher: $atomicLauncher,
      feeHook: $feeHook,
      lpLocker: $lpLocker,
      router: $router,
      buybackBurner: $buybackBurner
    },
    evidence: {
      deployBroadcast: $deployBroadcast,
      launchBroadcast: $launchBroadcast,
      launchReport: $launchReport,
      testnetVenueReport: (if $venueReport == "" then null else $venueReport end)
    }
  }' > "${deploy_report_dir}/${deploy_chain_id}.json"

echo "Deployment complete; mint remains closed. Manifest: ${deploy_report_dir}/${deploy_chain_id}.json"
