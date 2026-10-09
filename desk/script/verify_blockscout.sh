#!/usr/bin/env bash
# Verify the six Desk contracts on Blockscout (robinhoodchain.blockscout.com, the official explorer;
# never rh-scan.com) from the address file the deploy script wrote. Constructor arguments are
# rebuilt from that file and the script's constants, so the encoding matches what was deployed.
#
#   cd desk && bash script/verify_blockscout.sh [rehearsal/mainnet-4663.json]
#
# Needs the same libraries the deploy compiled against (contracts/lib). Re-running is harmless:
# an already verified contract is reported as such.
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:-rehearsal/mainnet-4663.json}"
URL="${BLOCKSCOUT_URL:-https://robinhoodchain.blockscout.com/api/}"
CHAIN=4663
REGISTRY_6551=0x000000006551c19487814612e58FE06813775758

j() { python3 -c "import json,sys; print(json.load(open('$FILE'))['$1'])"; }
BONUS=$(j bonus); IMPL=$(j accountImpl); DESKS=$(j desks); RENDERER=$(j renderer); ENGINE=$(j engine); ROUTER=$(j depositRouter)
COAT=$(j coat); BROKERS=$(j brokers); POSTER=$(j poster); DEPLOYER=$(j deployer); TREASURY=$(j treasury)
USDG=$(j usdg); WETH=$(j weth); REGISTRY=$(j registry); BOOSTER=$(j booster); SID=$(j strategyId)
COAT_ROUTER=$(j coatRouter); ETH_POOL=$(j ethPool); ETH_FEED=$(j ethFeed)
[ "$(j chainId)" = "$CHAIN" ] || { echo "$FILE is not a chain $CHAIN deployment" >&2; exit 2; }
COMMIT=$(cast keccak "$(tr -d '\n' < art/traits-packed.hex)")

verify() { # name path address encoded-constructor-args
  echo "== $1 at $3"
  forge verify-contract --chain "$CHAIN" --verifier blockscout --verifier-url "$URL" --watch \
    --constructor-args "$4" "$3" "$2" || echo "   (not verified: $1; re-run to retry)"
}

verify CoatBonusPool src/CoatBonusPool.sol:CoatBonusPool "$BONUS" \
  "$(cast abi-encode 'c(address,address,address,address)' "$COAT" "$BROKERS" "$POSTER" "$DEPLOYER")"
verify DeskAccount src/DeskAccount.sol:DeskAccount "$IMPL" \
  "$(cast abi-encode 'c(address)' "$ENGINE")"
verify DeskNFT src/DeskNFT.sol:DeskNFT "$DESKS" \
  "$(cast abi-encode 'c(address,address,address,address,address)' "$COAT" "$BONUS" "$REGISTRY_6551" "$IMPL" "$DEPLOYER")"
verify DeskRenderer src/DeskRenderer.sol:DeskRenderer "$RENDERER" \
  "$(cast abi-encode 'c(bytes32,address)' "$COMMIT" "$DEPLOYER")"
verify DeskEngine src/DeskEngine.sol:DeskEngine "$ENGINE" \
  "$(cast abi-encode 'c(address,address,address,address,address,uint256,address,address,address)' \
     "$USDG" "$WETH" "$DESKS" "$REGISTRY" "$BOOSTER" "$SID" "$BOOSTER" "$TREASURY" "$DEPLOYER")"
verify DeskDepositRouter src/DeskDepositRouter.sol:DeskDepositRouter "$ROUTER" \
  "$(cast abi-encode 'c(address,address,address,address,address,address,address,address,address)' \
     "$USDG" "$WETH" "$COAT" "$DESKS" "$ENGINE" "$COAT_ROUTER" "$ETH_POOL" "$ETH_FEED" "$DEPLOYER")"
echo "done: check each address on https://robinhoodchain.blockscout.com/address/<addr>?tab=contract"
