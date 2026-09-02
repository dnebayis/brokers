# Agent Brokers — Spec v0 (draft, not locked)

> Status: DESIGN. Nothing here is built or voted. Order of work agreed with the owner:
> (1) fix the NFT trait/rarity churn first, (2) then Agent Brokers, shadow-first.
> Build constraint, same as Desk and Playbooks: the deployed core (`contracts/`, Booster,
> COAT, hook) is not modified. Agents live in the keeper and in periphery contracts that
> only READ the core and act through The Floor and Playbooks-style TBA approvals.

## One line

Every Broker becomes an autonomous agent: it owns a wallet with real tokenized stock, reads
the same Congress disclosures the engine reads, decides what to do with its own salary from a
bounded set of actions, explains every decision in plain words, and competes with the other
1,775 agents on a public track record. The owner owns the agent, can override it, pause it,
or run it in "suggest only" mode.

## Why this and not another yield trick

- The floor problem is a differentiation problem: 1,776 identical cashflows price to the
  weakest seller. Agents with different policies and different track records stop being
  interchangeable; a Broker with a good record is worth more than the floor, provably.
- Demand: "an nft that is an ai agent with its own real stocks and its own record" is a
  story that travels outside crypto-native NFT circles; Autopilot sells human pilots, we
  sell the pilots themselves, and the market for them already exists (OpenSea).
- Flywheel: every agent action executes through The Floor (0.3% fee, 80% to Broker payroll),
  agents only run on ACTIVE Brokers (activation burn), copying a top agent costs COAT (burned).

## What an agent is

An agent = (Broker id) + (personality) + (policy) + (memory) + (record).

- **Personality** is derived deterministically from the Broker's frozen art traits (Type,
  accessories) plus token id. It never changes and it is the only "AI-flavored" thing that is
  fixed at mint; it sets defaults for the policy (risk appetite, holding horizon, which
  disclosure signals it trusts).
- **Policy** is the decision rule. v0: a small set of hand-written, deterministic policies
  (see below). v1: an LLM proposes within the same action set and the deterministic guard
  validates; the LLM never executes anything directly.
- **Memory** is the agent's own on-chain history: what it held, what it did, why.
- **Record** is its performance: value of wallet + realized USDG vs. (a) the raw Congress
  basket buy-and-hold, (b) SPY-equivalent, over 7/30/90 days. Computed by the keeper from
  chain state and Chainlink feeds, published hourly, hash-committed.

## Action set (bounded, the only things an agent can ever do)

1. `HOLD` — do nothing this round.
2. `CONVERT(share_bps)` — sell part of the wallet's stock into USDG through The Floor
   (Chainlink floors, keeper min-out), USDG stays in the Broker wallet.
3. `REENTER(share_bps)` — buy the live basket with USDG sitting in the wallet (Floor buy).
4. `TILT(member_set, weight_bps)` — overweight the names most recently disclosed by a chosen
   set of members (bounded by `MAX_TILT_BPS`, default 3000), executed as Floor legs.
5. `TO_COAT(share_bps)` — convert to COAT via The Floor (keeper-priced min-out, as Playbooks).

Every action carries the same economics gate as Playbooks (`PLAYBOOKS_MIN_USDG`) so an
agent never burns more gas than it moves. Hard risk limits are settable per collection and
per owner: max turnover per week, max single-name weight, cooldowns.

## v0 policies (deterministic, ship first)

| Policy | Personality default | Rule |
|---|---|---|
| Sleeper | Male/Female base | HOLD always (this is today's Broker) |
| Sweeper | accessory: briefcase | CONVERT 100% weekly (the "pay me in USDG" holder) |
| Fast Filer | accessory: glasses | TILT toward members whose disclosure lag < 20 days |
| Sharpshooter | accessory: cap | TILT toward top-decile track-record members only |
| Contrarian | Zombie | CONVERT when a name's disclosure count spikes, REENTER after decay |
| Momentum | Ape | REENTER on new epoch, HOLD otherwise |
| Alien | Alien | v1-only: LLM policy with the widest allowed action set |

Personality → default policy mapping is a starting point; the owner can pick any policy.

## v1: the LLM layer (shadow-first)

- Input per round: new filings since last round (structured by the indexer, incl. the AI
  parsing layer), member track-record scores, the agent's wallet, prices, its own memory.
- Output: one action from the set + a one-paragraph rationale + a confidence.
- Guard: deterministic validator checks the action against limits; an invalid action
  becomes HOLD with the rationale logged as "rejected".
- Shadow: for weeks the LLM decides and the keeper SIMULATES, publishing the simulated
  record next to the deterministic policy record. Promotion to live needs receipts, exactly
  like the smart basket.
- Cost control: decisions are event-triggered (new filing or new epoch), not hourly for all
  1,776; batched prompts; Sleeper policy costs nothing.

## Contracts (periphery only)

1. **AgentRegistry** — per Broker: policy id, owner-set limits, mode (`OFF` / `SUGGEST` /
   `LIVE`), `setAgent(tokenId, ...)` only by the current owner, self-invalidates on transfer
   (same authority model as Playbooks). Emits `AgentSet`, `AgentDecision(tokenId, action,
   rationaleHash)`.
2. **AgentExecutor** — keeper-only entry `run(ids, actions, minOuts)`; pulls stock from the
   TBA (one-time per-stock approval by the owner, same as Playbooks), executes through
   `BasketRouter`, returns proceeds to the same TBA. Never holds funds between calls. Rescue
   path for tokens sent to it by mistake, recoverable only above what is owed.
3. **RecordCommit** — hourly hash of the published record file (per-agent 7/30/90 returns),
   so the leaderboard is verifiable after the fact.

Reads from the core: `Booster.isActive`, `CoattailBroker.ownerOf/accountOf`,
`StrategyRegistry.getBasket`, `PlaybookEngine.playbookOf` (an agent in LIVE mode suspends a
sweep/convert playbook to avoid double execution).

## Copy market (later)

An owner can set their agent to `FOLLOW(tokenId)`: it mirrors another agent's actions one
round later. Following costs COAT per round (settable), split 50% to the followed agent's
wallet, 50% burned. Top agents earn from being followed; that revenue is inside the NFT and
travels with it.

## Non-dilution Q&A (required)

- *NFT devalue / bypass?* No. Agents run only on active Brokers; there is no agent without an
  NFT; differentiation and follow revenue give individual Brokers reasons to price above the
  floor rather than at it.
- *COAT devalue / bypass?* No new token. Follow fees and premium features are paid in COAT
  and burned; every agent action is Floor volume through the hooked pool.

## Honest limits

- v0 "agents" are rule policies with LLM narration; calling them AI decisions before the
  shadow record exists would be the Autopilot move we criticised. Copy: "your broker follows
  a policy and explains itself" until v1 earns "decides".
- Performance display is historical data, never a forecast; counsel one-pager before LIVE
  mode (same gate as Desk).
- Agents that trade more pay more fees; the leaderboard must show net-of-fees returns or it
  will reward churn.

## Build order

1. Trait/rarity fix ships first (separate track, `BrokerRenderer` v2).
2. Keeper: policy engine + simulation + record file, shadow only; site: agent pages with
   rationale feed and leaderboard (shadow-labelled).
3. AgentRegistry + AgentExecutor + tests (unit + mainnet fork against the deployed Floor).
4. Testnet full pass, counsel one-pager, mainnet LIVE mode opt-in.
5. LLM policy in shadow; promotion by receipts. Copy market last.
