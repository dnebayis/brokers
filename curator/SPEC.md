# Curator Desk — Spec v0 (decided 2026-09-08, not yet built)

> Status: DECIDED by the owner (2026-09-08), parameters settled the same day: fees are
> denominated and paid in USDG (stable, settable), the protocol share goes to the treasury,
> delta-only rebalancing is v1, curator registration is open from day one. Build starts. Same build rules as Desk, Playbooks and The
> Floor: the deployed core (`contracts/`, Booster, COAT, hook) is never modified; everything
> lives in `curator/` as its own foundry project reading the core through minimal interfaces.

## One line

Autopilot's "Pilot" model on-chain: a curator publishes one public, signed basket; a Broker
owner follows it with their Broker's own wallet, pays a USDG fee per 30 days, and confirms each
update with a signature before the keeper executes it through The Floor. Every curator's
record is public and net of fees. No Broker, no following.

## Why

- Proven demand off-chain: Autopilot runs $1.8B of follower money and $30M/yr revenue,
  $22M of it from Congress-style portfolios; 6,000 creators are on its waitlist; creators
  (Unusual Whales, Quiver, Litquidity) already publish there for revenue share.
- The on-chain slot is empty: Robinhood Social is manual copy, US-only, no creator pay;
  no copy/curator product exists on Robinhood Chain.
- Fuel that fits our rules: the curator's audience must buy a Broker to follow (floor buys),
  pays a USDG fee (owner decision: stable pricing), and every rebalance is Floor volume
  (0.3%, 80% to payroll). This is the Geez pattern (partner brings the crowd, the crowd buys Brokers)
  generalised to creators, with a product instead of a sponsorship.

## Roles

| Role | Who | Can |
|---|---|---|
| Curator | any address that registers and holds ≥1 Broker following its own basket | publish/update one basket (≤12 legs, sums to 100%), set its USDG fee, pause itself |
| Follower | the current `ownerOf(tokenId)` of an ACTIVE Broker | follow/unfollow, set limits, confirm updates, top up the wallet with USDG |
| Keeper | our hourly runner (settable address) | execute confirmed orders only, with Chainlink-floored min-outs |
| Venue | `BasketRouter` (The Floor), unchanged | `sellBasket` / `buyCustomBasket`, fee 0.3% |
| Record | indexer + `data` branch | per-curator NAV series, net of fees, hash-committed |

## Flow

1. **Publish.** Curator signs `Basket{curatorId, tokens[], weightsBps[], epoch, deadline}`
   (EIP-712, EIP-1271 accepted). Anyone can relay it; `epoch` must be exactly `last+1`
   (single use, ordered), the same trick as `StrategyRegistry.setStrategyWithSig`. Every leg
   must be routed on The Floor (`routes(token).pool != 0`); max 12 legs (`MAX_BASKET_LEGS`).
   The basket is public and identical for every follower.
2. **Follow.** Owner calls `follow(tokenId, curatorId, periods, limits)`: requires
   `ownerOf == msg.sender`, `booster.isActive(tokenId)`, curator live, no Playbook set on the
   token (`PlaybookEngine.playbookOf(tokenId).mode == NONE`), and pays `feePer30d ×
   periods` in the fee token (USDG; the token is settable for new follows). Records `principal = msg.sender` (self-revokes on transfer, as Playbooks'
   `setterOf`). One-time TBA approvals for each routed stock and USDG (same UX as Playbooks).
3. **Confirm.** When the curator publishes epoch N, every follower sees "basket updated,
   apply?". The follower signs `Confirm{tokenId, curatorId, epoch, deadline}`; the site
   relays it, the follower pays no gas. Unconfirmed epochs simply do nothing: the wallet
   keeps its current holdings. No drift-rebalancing, no scheduled trades, ever.
4. **Execute.** Keeper calls `run(orders[])`; each order = (tokenId, confirmation signature,
   minOuts). Engine verifies the signature against the current owner, checks the mandate is
   live, pulls the wallet's routed stocks (`transferFrom`, allowance-gated; short allowance
   = skip, never revert), sells to USDG on The Floor, buys the curator's basket with
   `recipient = tba`, and marks `appliedEpoch[tokenId] = epoch`. Proceeds never leave the
   Broker's own wallet. Economics gate as Playbooks: skip while wallet value <
   `minFollowUsd` (settable, proposal 25 USD at Chainlink).
5. **Unfollow / expiry.** Owner can `unfollow` any time (unused whole periods refunded from
   escrow, current period kept); a follow past `validUntil` is inert; a curator that pauses
   or unregisters freezes its followers (no execution) and stops accruing fees.

Followers can put USDG into their Broker wallet (plain transfer to the TBA) to give the
basket size; the engine treats wallet USDG as part of the wallet and buys with it on the
next confirmed epoch. This turns a Broker into a real account and is the largest Floor
volume this product creates.

## Contracts (`curator/src/`)

### `CuratorRegistry`

```
struct Curator { address owner; address signer; uint64 epoch; uint96 feePer30d; bool paused; string uri; uint256 skinTokenId; }
register(string uri, address signer, uint96 feePer30d, uint256 skinTokenId)
setSigner / setFee (fee change applies to NEW follows only) / setPaused / setUri
publish(curatorId, tokens[], weightsBps[], epoch, deadline, sig)   // anyone relays
basketOf(curatorId) -> (tokens, weights, epoch, publishedAt)
```

- `skinTokenId` must be a Broker owned by the curator and following the curator itself;
  checked at register and at every publish (skin in the game, the Hyperliquid 5% analogue).
- Registration is permissionless; the site keeps a curated "featured" list off-chain.
- Owner-only `freezeCurator` emergency door, event-logged (never touches follower funds).

### `FollowEngine`

```
struct Follow { uint64 curatorId; address principal; uint48 validUntil; uint64 appliedEpoch; uint16 maxWalletBps; bool paused; }
follow(tokenId, curatorId, periods, maxWalletBps)     // pays USDG, escrowed per period
unfollow(tokenId) / pause(tokenId, bool) / extend(tokenId, periods)
run(Order[] orders)                                    // keeper or owner
  Order { uint256 tokenId; uint64 epoch; uint256 deadline; bytes confirmSig; uint256 minUsdgOut; }
canExecute(tokenId, epoch) -> (bool, reason)           // public view for the site/keeper
```

- Confirmation signature = EIP-712 `Confirm(uint256 tokenId,uint64 curatorId,uint64 epoch,uint256 deadline)`
  by the CURRENT `ownerOf(tokenId)`; each (tokenId, epoch) executes at most once.
- Execution order per Broker: `sellBasket(all routed stocks held, USDG, minUsdgOut, tba)` →
  `buyCustomBasket(tokens, weights, usdgIn = wallet USDG × maxWalletBps, tba)`. Two Floor
  fees per rebalance (0.3% each way); v1 may add delta-only rebalancing to halve that.
- Reads only: `ownerOf/accountOf`, `booster.isActive`, `playbookOf`, `routes`, Chainlink via
  Booster `stockFeed`. Writes only to The Floor. Holds nothing between calls except the USDG
  fee escrow.
- Hard ceilings as constants, everything else settable: `MAX_CURATOR_SHARE_BPS = 8000`,
  `MAX_LEGS = 12`, `MIN_PERIOD = 30 days`.

### Fees (USDG, stable; no new token, no new burn)

- Owner decision: fees are denominated in a stable unit so a curator's price does not swing
  with COAT. `feeToken` = USDG (6 decimals), settable by the protocol owner for NEW follows
  (existing escrows keep their token). `feePer30d` set by the curator in feeToken units
  (site suggests a range; default proposal 5 USDG).
- Split at each period start (settable, proposal 70% curator / 30% protocol, curator share
  ceiling 80%). Curator share is claimable by the curator after the period ends (an unfollow
  inside a period refunds only whole unused periods and never claws back paid periods).
- Protocol share goes to the **treasury** (`feeSink`, settable; owner decision: treasury).
- No AUM fee, no performance fee in v0 (performance fees look like management; revisit in
  v1 with a high-water mark only after the record exists).
- COAT's role in this product is therefore indirect: activation (burn) to be eligible,
  Floor volume through the hooked pool, and any COAT the follower chooses to hold; the fee
  path itself is USDG by owner decision.

## Legal framing (why the confirm step exists)

- **Lowe v. SEC (1985)**: a publication of general and regular circulation, not tailored to
  a person and not timed to specific market activity, is not investment advice. A curator
  publishes one basket for everyone; nothing is per-follower.
- **ESMA Q&A 2012/382 Q9**: automatic execution of third-party signals is portfolio
  management; "where no automatic order execution occurs because client action is required
  prior to each transaction, the activity will not amount to portfolio management." Hence
  the per-epoch confirmation signature, no drift trades, no schedules.
- Autopilot solves the same problem by being an RIA; we solve it by never executing without
  the follower's fresh instruction. Counsel one-pager before any curator other than
  Coattail Smart is paid (same gate as Desk); curator pages carry the "published for all
  followers alike, not tailored to any holder" line, the Hyperliquid/Binance risk sentence,
  and the same jurisdiction gate as the mint.

## Record (indexer)

- Daily NAV of every following wallet at Chainlink prices, grouped by curator; returns net
  of Floor and curator fees vs (a) hold, (b) the live Congress basket, (c) SPY, over
  7/30/90 days; also "confirmation lag" (how fast followers apply).
- Published to the `data` branch with a hash, same method as the basket scorecard; curator
  card = the scorecard renderer with the curator's name.

## Frontend

- `/curator/<slug>` public pages (basket, fee, record, followers count, epoch history).
- Follow panel inside My Brokers per Broker (copy `PlaybookPanel`: approvals loop, then
  `follow`); a "Curators" section in the Trade tab listing featured curators.
- Pending-confirmation banner per Broker with one-click sign; Wallet Pass field later.
- `curator.ts` (addresses, ABI) copied from `playbooks.ts`.

## Keeper

Hourly, appended to the existing run: for each follow with `appliedEpoch < curator.epoch`
and a stored confirmation for that epoch, price min-outs from Chainlink (as Playbooks does),
apply the economics gate, batch ≤25 orders per tx. Skips Playbooks on followed Brokers
(one driver per Broker). Confirmations are stored off-chain (site → KV) until executed;
losing them only delays execution until the follower signs again.

## Non-dilution Q&A (required)

- *NFT devalue or bypass?* No. Following needs an active Broker and uses that Broker's own
  wallet; there is no NFT-less path. Curators must hold a Broker. Good curator records make
  following Brokers price above the floor.
- *COAT devalue or bypass?* No new fungible and no new burn channel. Fees are USDG by owner
  decision (stable pricing for curators); COAT keeps its activation and Floor roles, and the
  fee token stays settable if the owner later wants a COAT lane.
- *Payroll?* Untouched; every rebalance adds Floor fees to payroll.
- *Custody?* None. Funds move TBA → Floor → TBA inside one call; the engine only escrows
  USDG fees, which belong to curator/protocol per period.

## Parameters (all settable, no redeploy)

| Param | Proposal |
|---|---|
| `curatorShareBps` | 7000 (ceiling 8000) |
| `minFollowUsd` | 25 USD |
| `defaultMaxWalletBps` | 10000 (follower may lower) |
| `maxPeriodsPrepaid` | 12 |
| `feeToken` | USDG (settable for new follows) |
| `feeSink` | treasury (owner decision) |
| `keeper` | existing keeper address |
| `floor` | BasketRouter (upgradable pointer, as Playbooks) |

## Build order and estimate

| Week | Work |
|---|---|
| 1 | `CuratorRegistry` + `FollowEngine` + unit tests + mainnet-fork tests against the live Floor (`Fork*.t.sol` pattern); Coattail Smart registered as curator #1 with fee 0 |
| 2 | keeper (confirmations store, min-outs, batching); indexer record + curator cards on `data` |
| 3 | frontend (curator pages, follow panel, confirm banner, Trade-tab section); docs; testnet full pass |
| 4 | counsel one-pager; mainnet with Coattail Smart only (registration open to all from day one, featured list curated); then first two creators (rev-share + a free Broker, no cash) |

Buildathon: submission window closes 2026-10-04; weeks 1-3 fit, Coattail Smart live on
mainnet is the demo.

## Decisions taken (2026-09-08, owner)

1. Fee unit: USDG (stable), `feeToken` settable for new follows; default `feePer30d` proposal 5 USDG.
2. Protocol share of fees: treasury.
3. Rebalancing: v0 sells all routed stocks to USDG and buys the target; delta-only rebalancing is v1.
4. Curator registration: open to everyone from day one; the site's featured list is curated.
