#!/bin/bash
# Coattail emergency rewire — point the 3 basket stock routes at Uniswap v3 USDG pools
# while Rialto's venue is halted (all equity pools reverting "ACF" since 2026-08-25 16:19 UTC).
#
# Same-factory guarantee: all three target pools were created by factory
# 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA — the factory of the WETH/USDG midPool
# every mainnet buy already routes through. Feeds are unchanged (already set), and the
# Booster's Chainlink minOut guard stays in force, so a bad pool can only revert, not steal.
#
# Pool depth & price at selection time (2026-08-26, all matching feeds within ~0.3%):
#   INTC fee 3000: ~$40K   | SPCX fee 500: ~$928K | MU fee 3000: ~$58K
#
# Run with the OWNER key. Reverting to Rialto later = re-run the old setRoute lines
# from wire-universe.sh (kind 0).
set -euo pipefail
RPC="${RPC:-http://127.0.0.1:18545}"
: "${OWNER_KEY:?export OWNER_KEY=0x... (owner private key, never share it)}"

ROUTER=0x99F3f896B58bcb8A515ED3C7174c017B5a55075a
BOOSTER=0x7bAf435847A4b45c2e22a7fd13549C3192C95953
MID_POOL=0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca   # WETH/USDG v3 (unchanged)
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168

INTC=0xc72b96e0E48ecd4DC75E1e45396e26300BC39681
SPCX=0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa
MU=0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD

INTC_POOL=0x2e5a92f5013a64661A49312111be2e8aBd33F56a  # v3 fee 3000
SPCX_POOL=0xc61284332117c3FB23A2A56cceFFD07F7aF60029  # v3 fee 500
MU_POOL=0xd057B1Bc54917855BBee58eAd58647f47caB35E5    # v3 fee 3000

echo '== pre-check: her hedef havuzun cifti dogru mu (token0/token1)'
for entry in "INTC $INTC $INTC_POOL" "SPCX $SPCX $SPCX_POOL" "MU $MU $MU_POOL"; do
  set -- $entry
  T0=$(cast call $3 'token0()(address)' --rpc-url $RPC)
  T1=$(cast call $3 'token1()(address)' --rpc-url $RPC)
  echo "$1: pool $3 token0=$T0 token1=$T1 (beklenen: $2 + USDG)"
done

echo '== wire: setRoute x3 (PoolKind.V3 = 1)'
cast send $ROUTER 'setRoute(address,address,address,address,uint8)' $INTC $MID_POOL $USDG $INTC_POOL 1 --rpc-url $RPC --private-key $OWNER_KEY
cast send $ROUTER 'setRoute(address,address,address,address,uint8)' $SPCX $MID_POOL $USDG $SPCX_POOL 1 --rpc-url $RPC --private-key $OWNER_KEY
cast send $ROUTER 'setRoute(address,address,address,address,uint8)' $MU   $MID_POOL $USDG $MU_POOL   1 --rpc-url $RPC --private-key $OWNER_KEY

echo '== post-check: routeReady + gercek alim simulasyonu (eth_call, gaz harcamaz)'
for entry in "INTC $INTC" "SPCX $SPCX" "MU $MU"; do
  set -- $entry
  READY=$(cast call $ROUTER 'routeReady(address)(bool)' $2 --rpc-url $RPC)
  OUT=$(cast call $ROUTER 'swapExactETHForStock(address,uint256,address,uint256)(uint256)' \
        $2 0 $BOOSTER $(( $(date +%s) + 600 )) \
        --from $BOOSTER --value 1000000000000000 --rpc-url $RPC) || OUT="SIM-REVERT"
  echo "$1: routeReady=$READY  0.001 ETH sim out=$OUT"
done

echo 'Bitti. Sonraki keeper run poke ile birikmis bufferi harcayacak.'
