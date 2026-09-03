#!/bin/bash
# Coattail universe rewire: point every basket-eligible stock at a funded Uniswap v3 USDG pool.
# Rialto (PoolKind 0) has reverted "ACF" on every stock pool since 2026-08-25, so 18 of the 25
# route-ready names could not be bought; four more names (ASML, BABA, MSTR, TSM) gain a feed +
# route for the first time. Same factory as the WETH/USDG mid pool; feeds are Chainlink; the
# Booster's minOut guard stays in force. Probed on a mainnet fork first (ForkStockRoutesV3Universe).
# Run with the OWNER key:  OWNER_KEY=0x... RPC=https://rpc.mainnet.chain.robinhood.com bash rewire-v3-universe.sh
set -euo pipefail
RPC="${RPC:-https://rpc.mainnet.chain.robinhood.com}"
: "${OWNER_KEY:?export OWNER_KEY=0x... (owner private key, never share it)}"
ROUTER=0x99F3f896B58bcb8A515ED3C7174c017B5a55075a
BOOSTER=0x7bAf435847A4b45c2e22a7fd13549C3192C95953
MID_POOL=0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
# symbol token pool feed new?
ENTRIES=(
  "AAPL 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9 0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D 0xBb11A21267cFDb63d4935d99a499133DD1744ACb rewire"
  "AMD 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC 0x48D284A2A4d3DC1b3Da08231Fe44317e7e7Aa51f 0xdAD54b8Ee51Af258e5A6Faa9a84a3300f4775f7d rewire"
  "AMZN 0x12f190a9F9d7D37a250758b26824B97CE941bF54 0x8AC92DA74AB5F3b1d024Dc1943Ad7e15Dc4179Ef 0x93503dFc97157cdB8aADcCaf70452621d598FDeb rewire"
  "ASML 0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA 0xedb22516B14Eb2d1C86927Db373B0E8bF70F5cD1 0xF795030a46ad6CA4b07Bf5fB704dC36039118c9F new"
  "BABA 0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4 0xa57ab582b310dd6f9e934EA1EEEa152741545E6A 0xFf5F85e4888782e66f1dd9cabaDF4822Fbeb1439 new"
  "CRCL 0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5 0x654E4143e82a5824445Ade0824351C2A9ACD95a8 0x901D8DF245E48Dfc82D6483FC45b5BE6ddc5281a rewire"
  "GME 0x1b0E319c6A659F002271B69dB8A7df2F911c153E 0xE2b46c905E12Ab8E2f864e4821a4325884C1B126 0xf83Cde62D1Cd90dE8d2Bf3332B90c590985aD679 rewire"
  "GOOGL 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3 0x34D0dC122CF9A8Eb296fC5e0D3A233625D7d19b7 0x11eD6d598eF565DDA86fAfE7E779303e7CC6b2Bd rewire"
  "META 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35 0x107a7Cb40d8665360ba10E59471Af06150A50922 0xc190B6164B9e320A6400cdaB0085a2e0E2b9738e rewire"
  "MSFT 0xe93237C50D904957Cf27E7B1133b510C669c2e74 0xeb60bCD1D920ad6E102690CCFC6fB488899E1510 0xc3b117F52cf17Dd4369eaF5eaf7cF0E2f91b4E30 rewire"
  "MSTR 0xec262a75e413fAfD0dF80480274532C79D42da09 0x17578C0e0D15da44f31677263114F71aE76653EA 0x55bd01F666c99E4590E084FdEfF88041BB50CCD1 new"
  "NVDA 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3 0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2 rewire"
  "PLTR 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A 0x851680416A4f4E1c463d45171d61ACDdBc8554c0 0x315afd0f71D5407B99ad19ab001a67af40fbAAF4 rewire"
  "QQQ 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68 0xD60A5d14dB690B7Afad71F76B108071D7175597d 0x25e996ce8b3529885D429241156e83e7b7744049 rewire"
  "SGOV 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5 0xfAb520051f96F4D2a32c22B6a3dD7fFfdf231bFe 0x0E96B7708487f91baAC09697593D3e8bf253f2d8 rewire"
  "SLV 0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f 0x8cB787e6c315D464775289BaD00FDD67d53Ecb3D 0xcdF6F7043b3aF6Afa0CAAACe1230B355096B5386 rewire"
  "SNDK 0xB90A19fF0Af67f7779afF50A882A9CfF42446400 0xA1e1C9519cD5ae47e9A935645E1A7b935b944559 0x7B2FdfcEa772f093DD33b3aCF8EE294B368f6c23 rewire"
  "SPY 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C 0xa7Bb1AC63BBaB0C44316E6c8C455213441689167 0x78BCB218fA04B9b3a278eBc865Ed320BF8DEFBAc rewire"
  "TSLA 0x322F0929c4625eD5bAd873c95208D54E1c003b2d 0xf4ACdAEEB7022862A763C9B1B885e11191c889E3 0x7A6b81ba7FbCB90104d8C496158Cf383cD7233b1 rewire"
  "TSM 0x58FfE4a942d3885bAa22D7520691F611EF09e7AA 0x07e8Ea83D4C1340774c8965125e26e12bf943bf1 0x2B3A9A18998e9464760658233ab093e6aEbF45d0 new"
  "USAR 0xd917B029C761D264c6A312BBbcDA868658eF86a6 0x04391780F519B7d3ba59c9590459D76e23d225C4 0x76ba75c6c362900B275D9D4d5C422F0275e85578 rewire"
  "USO 0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344 0x02175608F1b5E6b5ed221cCFdC7Be197D111D915 0xa6aC45e27D19f91c55109191D71CfBA4A9f5fBe1 rewire"
)
echo "== pre-check: each pool pairs the stock with USDG"
for e in "${ENTRIES[@]}"; do set -- $e
  # macOS ships bash 3.2 (no ${var,,}): lower-case through tr
  lc() { echo "$1" | tr '[:upper:]' '[:lower:]'; }
  T0=$(lc "$(cast call $3 "token0()(address)" --rpc-url $RPC)"); T1=$(lc "$(cast call $3 "token1()(address)" --rpc-url $RPC)")
  S=$(lc "$2"); U=$(lc "$USDG")
  [ "$T0" = "$S" ] || [ "$T1" = "$S" ] || { echo "$1: pool does not contain the stock"; exit 1; }
  [ "$T0" = "$U" ] || [ "$T1" = "$U" ] || { echo "$1: pool does not contain USDG"; exit 1; }
  echo "  $1 ok"
done
echo "== feeds for new names (setStockFeed), then setRoute for every entry (PoolKind.V3 = 1)"
for e in "${ENTRIES[@]}"; do set -- $e
  if [ "$5" = "new" ]; then
    cast send $BOOSTER "setStockFeed(address,address)" $2 $4 --rpc-url $RPC --private-key $OWNER_KEY | grep -E "^status" | sed "s/^/  $1 feed: /"
  fi
  cast send $ROUTER "setRoute(address,address,address,address,uint8)" $2 $MID_POOL $USDG $3 1 --rpc-url $RPC --private-key $OWNER_KEY | grep -E "^status" | sed "s/^/  $1 route: /"
done
echo "== post-check: routeReady + 0.001 ETH buy simulation from the Booster (eth_call, no gas)"
for e in "${ENTRIES[@]}"; do set -- $e
  READY=$(cast call $ROUTER "routeReady(address)(bool)" $2 --rpc-url $RPC)
  OUT=$(cast call $ROUTER "swapExactETHForStock(address,uint256,address,uint256)(uint256)" $2 0 $BOOSTER $(( $(date +%s) + 600 )) --from $BOOSTER --value 1000000000000000 --rpc-url $RPC 2>/dev/null) || OUT="SIM-REVERT"
  echo "  $1: routeReady=$READY sim=$OUT"
done
echo "Done. Next: update indexer/route-ready.mainnet.json + indexer/tokens.py (route-ready list) and let the next indexer pass rebuild the basket."
