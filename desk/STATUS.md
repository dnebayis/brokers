# The Desk: where it stands

_Updated 2026-10-09. The single place to look before picking the Desk back up. The design and
its history are in [SPEC.md](SPEC.md); the internal audit is [AUDIT-2026-10-02.md](AUDIT-2026-10-02.md)._

## Current step

**Ready for the mainnet broadcast.** Everything up to and including a rehearsed mainnet deploy
script is done. One decision and one signature remain:

1. **Mint price.** 120,000 COAT, about $10.60 on 2026-10-05. Waiting for the founder's yes
   (or a new number; `mintPrice` is settable after deploy too).
2. **The broadcast.** The deployer signs it from their own terminal (command below). The
   deployer wallet holds about 0.0092 ETH on mainnet; the dry run needs about 0.00116 ETH.

After the broadcast, work through [After the deploy](#after-the-deploy) in order.

## What is built and verified

| Piece | State |
|---|---|
| Contracts (`src/`) | CoatBonusPool, DeskAccount (ERC-6551), DeskNFT, DeskRenderer (on-chain art, traits frozen to a commit), DeskEngine, DeskDepositRouter (USDG, ETH, COAT) |
| Audit | internal audit 2026-10-02, 7 fixes incl. one HIGH (cap bypass with directly sent stock); see the audit file and its addendum |
| Tests | 86 unit/fuzz/invariant tests + 8 mainnet fork tests, all green (`forge test`; fork suites need a live RPC, CI skips them by contract name) |
| Testnet | v3 live on 46630 (`rehearsal/testnet-46630-v3.json`), keeper on GitHub Actions (`desk-keeper-testnet.yml`, switched on 2026-10-04, running) |
| Mainnet script | `script/DeployDeskMainnet.s.sol`, dry run clean (26 routes, ~0.00116 ETH) |
| Mainnet rehearsal | the script broadcast onto a mainnet fork and every flow driven with the keeper's own code: 26/26 (`rehearsal/deployed-check-mainnet.md`) |
| Site | Desk tab built (`frontend/src/components/desk/`, `tabs/DeskTab.tsx`), design approved 2026-10-05, hidden behind two keys (mainnet Desk addresses in `frontend/deployments.json` AND `NEXT_PUBLIC_DESK_TAB=1`) |
| Keeper | `keeper/desk_keeper.py`: universe from the engine, one multicall per tick for every Desk, quiet Desks skipped, at most $2,500 per Desk per tick, name-by-name fallback, nonce = max(pending, latest) |
| Mainnet keeper workflow | `.github/workflows/desk-keeper-mainnet.yml`, inert until `DESK_MAINNET_KEEPER=1` |

## Launch parameters (decided)

| Lever | Value | Decided |
|---|---|---|
| Supply | 2,000 Desks, all mintable from day one (`mintCap` = `MAX_DESKS`); no waves | 2026-10-07 |
| Mint price | 120,000 COAT, 100% to the CoatBonusPool for active Brokers, none burned | 2026-08-26 (reconfirm pending) |
| Mint at deploy | **closed**; opened by one `setMintOpen(true)` after the checks | script default |
| Deposit cap | **none** (`depositCapUsdg` = uint256 max; `setDepositCap` stays a lever). Principal is still booked and shown | 2026-10-07 |
| Deposit currencies | USDG, ETH (Chainlink-floored), COAT (98% of quote on the site) | 2026-09-27 |
| Service fee | 0.5% of every engine trade (hard ceiling 1%) | community vote |
| Fee split | **100% to the Booster** as native ETH (`boosterShareBps` 10,000, settable) | 2026-10-07 |
| Basket | the live basket, strategy 0 (the one Broker salaries are paid in); names without a v3 USDG pool are skipped and the rest scaled up | design |
| Keeper | the Booster's keeper relay `0xa492c8fFa033016144B169501D2e428BeDD518CA`, signing with the existing `TESTNET_KEEPER_PRIVATE_KEY` secret; it is also the bonus-round poster | 2026-10-07 |
| Treasury | the deployer (receives nothing while the split is 100% Booster) | 2026-10-07 |

Note for the launch post: the pilot was voted with a $1,000 cap and waves of 500; both were
lifted by the founder on 2026-10-07. A one-line mention is worth it.

## The broadcast

```bash
cd desk && forge script script/DeployDeskMainnet.s.sol \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --broadcast --slow --sender 0x9e643731dc9D8795573Aa34C410664407FfDC440 --interactives 1
```

Writes `rehearsal/mainnet-4663.json`. Defaults: keeper and poster = the relay, treasury = deployer,
mint closed. Override with `DESK_KEEPER`, `DESK_POSTER`, `DESK_TREASURY`, `DESK_OPEN_MINT`.

## After the deploy

1. **Check the real deployment on a fork** (nothing is sent; opens the mint on the fork only):
   `cd desk && DESK_NETWORK=mainnet DESK_ADDRESSES=rehearsal/mainnet-4663.json FORK_RPC=<metered mainnet url> python3 script/check_deployed.py`
   (`FORK_RPC` is `NEXT_PUBLIC_RPC_URL_MAINNET` from `frontend/.env.local`; the script sends the
   coattail.cash Origin header itself. The public node drops old state within minutes, so it
   cannot hold a fork for the whole run.)
2. **Verify the six contracts on Blockscout** (`robinhoodchain.blockscout.com`, never rh-scan.com).
3. **Commit** `rehearsal/mainnet-4663.json` and add `mainnet.desk` to `frontend/deployments.json`
   (`usdg`, `desks`, `engine`, `depositRouter`, `strategyId: 0`, `deployBlock`).
4. **Open the mint**: deployer calls `DeskNFT.setMintOpen(true)`.
5. **Switch the keeper on**: `gh variable set DESK_MAINNET_KEEPER --body 1`, then
   `gh workflow run desk-keeper-mainnet.yml`.
6. **Show the tab**: `NEXT_PUBLIC_DESK_TAB=1` on Vercel (production), redeploy.
7. **Announce** (lowercase, no em-dash, no dollar figures for earnings, no fee split).

## Open items

- **Bonus rounds tooling is not built.** Mint COAT lands in the CoatBonusPool; paying it out
  needs a snapshot of active Brokers, a merkle tree, `postRound` (by the keeper relay) and claims.
  The tranche-drop flow (`COAT_DROPS`, `distribute.sh`) is the model. Needed before the first
  round, not before launch.
- **Desk promo video** (15 s, HyperFrames) is on another branch:
  `claude/coattail-desk-hyperframes-video-b29455`, `desk/video/`; music track choice open
  (HeyGen catalog only, never MusicGen).
- **Testnet v3** still has the old 80/20 split and the $1,000 cap (`pilotCapUsdg`); harmless,
  the site and `check_deployed.py` read both shapes.
- **Rialto names** (7) have no v3 USDG pool, so a Desk cannot hold them; the engine skips them.

## How to check things

| What | Command (from `desk/`) |
|---|---|
| unit, fuzz, invariant tests | `forge test --no-match-contract Fork` |
| mainnet fork tests | `forge test --match-contract Fork` |
| testnet end-to-end on a fork (fresh deploy) | `python3 script/rehearse_local.py` |
| a deployed testnet set | `DESK_ADDRESSES=rehearsal/testnet-46630-v3.json python3 script/check_deployed.py` |
| the mainnet deploy, rehearsed on a fork | `DESK_NETWORK=mainnet FORK_RPC=<metered url> python3 script/check_deployed.py` |
| the site tab locally | `python3 script/local_env.py`, then the `desk-lab` preview (`NEXT_PUBLIC_DESK_LAB=1 NEXT_PUBLIC_DESK_TAB=1`) at `/desk-lab?view=site`, wallet "Local test wallet" |
| move test prices | `python3 keeper/desk_basket.py price tAAPL=+5%` (testnet: `RPC=… DESK_ADDRESSES=… KEEPER_KEY_FILE=keeper/.testnet-keeper.json`) |

Secrets never enter chat or the repo: the testnet keeper key is in gitignored
`keeper/.testnet-keeper.json`; mainnet signing is the founder's.
