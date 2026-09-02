# Uniswap v4 hook routing allowlist — submission draft

Form: https://developers.uniswap.org/hook-allowlist
Why we must submit: CoatFeeHook uses a delta flag (`AFTER_SWAP_RETURNS_DELTA`), which is one of
the three cases Uniswap Labs lists as requiring manual review. Until it is approved, the
Uniswap app cannot route through our pool and quotes COAT from thin third-party pools.

Everything below is verifiable on chain; paste the fields as they are.

## Contact

- First name / last name: (owner fills in)
- Email: (owner fills in)
- Telegram: (owner fills in)

## Hook name

CoatFeeHook (Coattail Brokers)

## Hook description

CoatFeeHook is a single-pool afterSwap fee hook for the native ETH / COAT pool on Robinhood
Chain. On every swap it takes a fixed 1% of the unspecified currency via `PoolManager.take`
and returns that amount as the hook delta, which is why the delta flag is set. ETH taken on
sells is forwarded to an immutable-fee FeeSplitter that funds tokenized-stock purchases for
NFT holders; COAT taken on buys is burned. The hook also records a tick-cumulative observation
on each swap so a TWAP can be consulted on chain.

What it does not do: it never modifies swap amounts before execution, never blocks swaps
after the launch protection window (a per-transaction max-buy cap that expired at the block
recorded in the COAT token), takes no hookData (the parameter is ignored), and has no upgrade
path. The fee is a compile-time constant (`FEE_BPS = 100`). The only owner function is
`setEthSink`, which changes where the already-collected ETH fees are forwarded; it cannot
touch the pool, the fee rate or user funds in flight.

Permission flags: `BEFORE_INITIALIZE | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA`
(`beforeInitialize` only restricts pool initialization to the one-shot launch contract, so the
publicly predictable pool key could not be front-run before launch).

## Hook address

`0x51149a925E9193EA13Ae406Da6Cc154EccD0A044` (Robinhood Chain, chain id 4663)

## Pool

- Pool id: `0x2d503dda028be83d2e133e5e73a8839f1f202d9f6447e3d863e33ad2c8ebc3d2`
- currency0: native ETH (`0x0000000000000000000000000000000000000000`)
- currency1: COAT `0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833`
- fee: 10000 (1%), tickSpacing: 200
- PoolManager: `0x8366a39CC670B4001A1121B8F6A443A643e40951`
- Liquidity: the position is held by a permanent locker with no withdrawal path
  (`0x7EEc1cD28947bb41bdBa8E0C46087d8135F22bCf`); this is by far the deepest COAT pool on the
  chain, so it is fully reviewable with live liquidity.

## Chain(s)

Robinhood Chain mainnet (4663). No other deployments.

## Source code

- Repository: https://github.com/dnebayis/brokers (`contracts/src/CoatFeeHook.sol`)
- Verified source on the chain explorer:
  https://robinhoodchain.blockscout.com/address/0x51149a925E9193EA13Ae406Da6Cc154EccD0A044?tab=contract

## Website

https://coattail.cash

## Audit

No third-party audit firm was engaged. The repository carries an internal security review
(`AUDIT.md`) covering the hook, the token and the fee path, plus unit, fuzz, invariant and
mainnet-fork test suites. The hook is immutable, so the code under review is the code that
will run.

## Traction

Live since launch on Robinhood Chain: a 1,776-piece sold-out NFT collection whose holders are
paid from this hook's fees, roughly 1,180 active holders, over 180M COAT (18% of the fixed
supply) burned through the hook and the activation mechanism, and hourly automated basket
purchases funded by the ETH side of the fee. The hook is the only revenue source of the
protocol, so every COAT trade on Uniswap directly benefits from correct routing.

## Notes for the reviewer

- Users on the Uniswap app currently receive about one eighth of the real fill for ETH to
  COAT swaps, because routing falls back to shallow unhooked pools created by third parties
  (several with 84 to 95% fees). Allowlisting the hook fixes this for every Uniswap user.
- Our own site and OpenSea's swap already quote the hooked pool correctly, which is the
  reference for the expected fill.
