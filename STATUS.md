# Coattail Brokers — system status

_Updated 2026-08-31. This is the canonical description of what is live. It supersedes the
pre-launch remaining-work list; the historical deploy-day sequence is preserved in
[MAINNET_READINESS.md](MAINNET_READINESS.md)._

## Live on mainnet (chain 4663)

| | |
|---|---|
| Collection | 1,776 / 1,776 minted — **sold out** |
| $COAT | fixed 1B supply, trading open, no team allocation |
| Engine | buys the disclosed-Congress basket hourly; StrategyRegistry at epoch 50 |
| Active Brokers | ~1,034 switched on and earning (live figure on the site) |
| $COAT burned | ~138.7M, 13.9% of supply, permanently removed |
| Stock universe | 7 route-ready names wired into the Booster; expandable by owner op, no redeploy |
| Weekend trading | OPEN since 2026-08-31 (community vote): both staleness windows widened 24h → 96h by owner txs, so weekends trade at Friday's close; an off-chain keeper watchdog replaces the tripwire the wide window loosened |
| Fee routing | 100% of hook fees and 100% of Floor fees now reach the Booster: FeeSplitter's treasury and buyback sinks both point at the Booster (owner ops, reversible), Floor split set to 100/0 |
| Verification | every contract source-verified on `https://robinhoodchain.blockscout.com` |

Addresses: [ADDRESSES.md](ADDRESSES.md). The official explorer is
`robinhoodchain.blockscout.com`; `rh-scan.com` is a lookalike domain and is not ours.

## Products

- **Brokers** — the base collection. Activating one burns `36,750 COAT` and adds an equal
  share of every engine purchase. Claims land in the Broker's own ERC-6551 wallet.
- **The Floor** (`exchange-floor/`, `BasketRouter`) — public terminal: buy or exit the whole
  live basket in one transaction, paying in $COAT, ETH or USDG. Chainlink floor on every
  leg, non-custodial, 0.3% fee (hard cap 1%), all of it converted to native ETH and streamed
  into Broker payroll by the hourly keeper (treasury share set to 0 by owner op).
- **Playbooks** (`playbooks/`, `PlaybookEngine`) — per-Broker standing orders the keeper
  executes. Claiming is already automatic for every Broker, so a playbook decides what happens
  *after* the claim: send the stocks to an address, or convert them to USDG through The Floor
  and deliver that. Owner-installed, pausable, revocable, and void the moment the Broker changes
  hands. No fee of its own.
- **Gift drops** (`contracts/src/GiftVault.sol`) — donated NFTs, one at a time, to a random
  ACTIVE Broker's own wallet. The winner is derived from a block hash the contract picks after
  the round opens, so neither the keeper nor the owner chooses; the cadence (`interval`) is
  enforced on chain. Gifts travel with the Broker and the holder pulls them out from My Brokers.
  Live on mainnet at `0xA58B2Cd80E9c08EE6B220Bc63Dd1E4704d78468b` (interval 3 days).
- **Earnings card** — every Broker in My Brokers can draw a PNG card (artwork, earned since
  switch-on, holdings) in the browser and post it to X; `/card/<id>` is the public version.

## Automation

An hourly GitHub Actions keeper advances, in order: hook flush → splitter flush →
threshold-eligible `poke` (the basket purchase) → TWAP-eligible buyback → Floor fee flush →
Playbooks execution → gift draw (open a round when the interval has passed, settle it seconds
later). Every stage is isolated: a deferred stage retries next hour and never
strands funds. The Congress indexer republishes the basket hourly; an invalid snapshot can
never replace the last valid basket. All the value-moving entry points are permissionless —
if our automation stops, anyone can call them.

Known operational limits, stated plainly:

- GitHub's scheduler is not reliable. Runs have been skipped for hours; a missed hour is
  made up on the next successful run (balances roll forward), but the delay is real.
- The 96h feed-staleness window means a genuinely broken feed could serve a stale price for
  up to four days on-chain. The keeper's feed watchdog narrows this in practice: on trading
  days it alerts when any stock feed is quiet past 30h (70h on Mondays for the weekend
  backlog).
- The keeper relay wallet needs periodic gas top-ups.
- The $COAT exit has no Chainlink floor of its own (it crosses the hooked pool), so the keeper
  computes that order's minimum out before running it, and skips any order it cannot price
  rather than sending an unguarded one.
- Playbook orders wait until the Broker's wallet is worth at least 5 USDG before the keeper
  moves it: a run costs ~1M gas and a Broker earns cents an hour, so hourly conversion would
  cost the treasury more than the salaries are worth. Claiming stays hourly for everyone.
  Measured cost of the move itself, on live mainnet state: 0 bps to sweep stocks, ~36 bps to
  convert to USDG.

## Guarantees that do not move

- 0% team allocation; nothing pre-mined, nothing reserved.
- Fixed 1B $COAT supply that only shrinks — fees buy stock and burn $COAT.
- The contracts that hold and move value have no upgrade path and no admin backdoor.
- Liquidity is locked in an ownerless permanent locker with no withdrawal path.
- No third-party audit firm was engaged for this project. `AUDIT.md` is an internal review,
  not a substitute for one. The code is open and verified — read it yourself.

## Testing

```bash
cd contracts      && forge test --no-match-path 'test/Fork*.t.sol'
cd exchange-floor && forge test --match-path 'test/Fork*' --fork-url https://rpc.mainnet.chain.robinhood.com
cd playbooks      && forge test
cd indexer        && python3 -m unittest discover -v
cd frontend       && npm run lint && npm test && npm run build
```

The Floor and Playbooks fork suites run against the **deployed mainnet contracts**, not
local copies: they replay the exact user paths, including the frontend's slippage math.

## Known gaps

- Metadata refresh: an ERC-20 sent directly into a Broker's wallet cannot notify the NFT
  contract, so a marketplace may need a manual refresh; `tokenURI` is correct on reread.
- `BrokerAccount.execute` is single-CALL by design (no batch, no delegatecall) and the
  implementation is immutable, so a single-transaction multi-stock withdrawal to an EOA is
  impossible. The clean exit is to hold or sell the Broker — the stock travels with it.
- Keys: the project runs on a single shared deployer/owner key, an accepted risk taken
  knowingly rather than a target state.
