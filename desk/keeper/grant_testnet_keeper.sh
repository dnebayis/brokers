#!/usr/bin/env bash
# Hands the testnet Desk's day-to-day jobs to the testnet keeper (Robinhood Chain testnet 46630
# only). Run by the deployer; asks for the deployer key once, hidden, and keeps it only in this
# shell's memory. Seven transactions:
#   1. engine.setKeeper(keeper)                      the keeper may buy, sell and flush fees
#   2. registry.grantRole(UPDATER_ROLE, keeper)      the keeper may post the Desk basket
#   3-6. transferOwnership(keeper) on the tAAPL, tMSFT, tNVDA and ETH test feeds
#                                                    the keeper can move test prices and keep the
#                                                    feeds fresh (the engine rejects prices older
#                                                    than 96h, the deposit router older than 24h)
#   7. 0.003 testnet ETH to the keeper for gas
#
#   cd desk && bash keeper/grant_testnet_keeper.sh
set -euo pipefail
cd "$(dirname "$0")/.."
RPC=https://rpc.testnet.chain.robinhood.com
DEPLOYER=0x9e643731dc9D8795573Aa34C410664407FfDC440
J=rehearsal/testnet-46630.json
KEEPER=$(python3 -c "import json;print(json.load(open('keeper/.testnet-keeper.json'))['address'])")
g() { python3 -c "import json;print(json.load(open('$J'))['$1'])"; }
[ "$(cast chain-id --rpc-url $RPC)" = "46630" ] || { echo "not testnet, stopping"; exit 1; }

echo "keeper: $KEEPER"
read -r -s -p "deployer private key (hidden, testnet): " PK; echo
[ "$(cast wallet address --private-key "$PK")" = "$DEPLOYER" ] || { echo "that key is not the deployer $DEPLOYER"; exit 1; }

send() { local what=$1; shift; echo "-> $what"; cast send "$@" --private-key "$PK" --rpc-url $RPC --json | python3 -c "import json,sys;r=json.load(sys.stdin);print('   status', r['status'], 'tx', r['transactionHash'])"; }
send "setKeeper"            "$(g engine)"   "setKeeper(address)" "$KEEPER"
send "grant UPDATER_ROLE"   "$(g registry)" "grantRole(bytes32,address)" "$(cast keccak UPDATER_ROLE)" "$KEEPER"
for f in taaplFeed msftFeed nvdaFeed ethFeed; do
  send "$f ownership"       "$(g $f)"       "transferOwnership(address)" "$KEEPER"
done
send "0.003 ETH for gas"    "$KEEPER" --value 0.003ether
unset PK

echo "checks:"
echo "   engine keeper:  $(cast call "$(g engine)" 'keeper()(address)' --rpc-url $RPC)"
echo "   updater role:   $(cast call "$(g registry)" 'hasRole(bytes32,address)(bool)' "$(cast keccak UPDATER_ROLE)" "$KEEPER" --rpc-url $RPC)"
for f in taaplFeed msftFeed nvdaFeed ethFeed; do echo "   $f owner: $(cast call "$(g $f)" 'owner()(address)' --rpc-url $RPC)"; done
echo "   keeper balance: $(cast balance "$KEEPER" --rpc-url $RPC -e) ETH"
