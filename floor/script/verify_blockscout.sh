#!/usr/bin/env bash
# Verify The Floor v2 on Blockscout (robinhoodchain.blockscout.com, the official explorer; never
# rh-scan.com) from the address file the deploy script wrote. Run it from the checkout that
# broadcast, so the compiler metadata matches byte for byte.
#
#   cd floor && bash script/verify_blockscout.sh [rehearsal/floor-v2-mainnet.json]
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:-rehearsal/floor-v2-mainnet.json}"
URL="${BLOCKSCOUT_URL:-https://robinhoodchain.blockscout.com/api/}"
j() { python3 -c "import json; print(json.load(open('$FILE'))['$1'])"; }
[ "$(j chainId)" = "4663" ] || { echo "$FILE is not a chain 4663 deployment" >&2; exit 2; }
ARGS=$(cast abi-encode 'c(address,address,address,address,uint256,address,address,address)' \
  "$(j usdg)" "$(j weth)" "$(j registry)" "$(j booster)" 0 "$(j booster)" "$(j treasury)" "$(j deployer)")
forge verify-contract --chain 4663 --verifier blockscout --verifier-url "$URL" --watch \
  --constructor-args "$ARGS" "$(j router)" src/BasketRouter.sol:BasketRouter
echo "check https://robinhoodchain.blockscout.com/address/$(j router)?tab=contract"
