# Agent Desk — Spec v0 (draft, not decided)

> Status: DESIGN, written 2026-09-08 as the lead of bake-off round 2b/3. Nothing built.
> Supersedes the "in-house policies run by our keeper" shape in `SPEC.md`: the seat is
> opened to OUTSIDE agents, who pay their own gas and bring their own models. Core
> (`contracts/`, Booster, COAT, hook) is never modified; everything below is periphery,
> same rule as Desk, Playbooks and The Floor.

## One line

Every active Broker is a pre-funded principal: a wallet with real tokenized stock and a
payroll that refills it. Agent Desk lets the owner hire any registered agent to run that
wallet under a bounded, revocable mandate. The agent trades only through The Floor, only
the routed names, only up to a daily cap, and every dollar always lands back in the
Broker's own wallet. Agents compete on a public net-of-fees record.

## Why now (what changed outside)

- Robinhood Chain already has an agent economy: Virtuals powers 5,600+ agents, $200M
  agent volume in the first three weeks, $2.7M raised for agent builders. Those agents
  need capital and a track record; they have neither by default.
- Ondo + Virtuals + Treasures opened 430+ tokenized stocks to 40,000 agents on
  Ethereum/Solana ("agent hedge funds, copy-trade vaults"). Nobody has done it on
  Robinhood Chain with Robinhood's own stock tokens and a fee that pays holders.
- Robinhood's own Agentic Trading (MCP, 70,000 beta accounts) normalises "let an agent
  trade a bounded account". We are the on-chain, NFT-owned version of that account.
- ERC-8226 (Regulated Agent Mandate, draft Apr 2026) standardises exactly our object:
  principal → agent, scoped to an asset, time-bounded, per-tx and cumulative caps,
  revocable, freezable. We adopt its vocabulary and its `canExecute`/`recordExecution`
  shape so our mandates are legible to anyone building on the standard.

## Roles

| Role | Who | Authority |
|---|---|---|
| Principal | Broker owner (checked `ownerOf`, snapshot like Playbooks' `setterOf`) | hires, sets caps, pauses, fires; mandate self-revokes on NFT transfer |
| Capital | the Broker's ERC-6551 wallet (`accountOf`) | one-time `approve(engine, MAX)` per stock and for USDG, sent through `execute` (same flow as Playbooks) |
| Agent | any address in `AgentRegistry` with a COAT bond | submits its own txs, pays its own gas; can rotate its signer |
| Venue | `BasketRouter` (The Floor), unchanged | 0.3% fee, 80% to Booster payroll, Chainlink floors on every leg |
| Record | indexer + `data` branch, hash-committed | per-agent net-of-fees return over all Brokers it runs |

## Contracts (periphery, own foundry project `agents/`)

### 1. `AgentRegistry`

- `register(string uri, address signer)`: locks `bondCoat` (settable, e.g. 50,000 COAT) and
  stores metadata (name, operator, strategy text, optional ERC-8004 agentId pointer).
- `setSigner(agentId, newSigner)` (ERC-8391 flavour: hot key rotation without losing the
  record). `unregister` starts a cooldown (settable, e.g. 7 days) during which every
  mandate naming the agent is frozen; bond returns after the cooldown. No slashing in v0
  (slashing needs a judge; the record is the judge).
- Owner-only `freezeAgent` as the emergency door (ERC-8226 `freezeAgent`), event-logged.

### 2. `MandateEngine`

Storage per Broker (`tokenId`):

```
struct Mandate {
  uint64  agentId;        // 0 = none
  address principal;      // owner at hire; mismatch with ownerOf => inert
  uint48  validUntil;     // owner-set, extendable
  uint128 dailyCapUsd;    // gross notional per UTC day, 8 decimals (Chainlink units)
  uint128 usedToday; uint48 dayStart;
  uint16  maxSingleNameBps; // optional concentration cap, 0 = off
  bool    paused;
}
```

Entry points:

- `hire(tokenId, agentId, validUntil, dailyCapUsd, maxSingleNameBps)`: `ownerOf == msg.sender`,
  `booster.isActive(tokenId)`, agent registered and not frozen. Also suspends a
  Playbook on the same Broker (reads `PlaybookEngine.playbookOf`, refuses to hire while one
  is set, to avoid double execution).
- `fire(tokenId)`, `pause(tokenId, bool)`, `setCaps(...)`: owner only, instant.
- `execute(tokenId, Order)`: **agent signer only** for that Broker's mandate. `Order` is one
  of: `buyStock(stock, usdgIn, minOut)`, `sellStock(stock, amountIn, outCur, minOut)`,
  `buyCustomBasket(tokens, weights, usdgIn)`, `sellBasket(tokens, amounts, outCur, minOut)`.
  Checks, in order: mandate live (principal == ownerOf, not paused, `validUntil`,
  agent not frozen, Broker still active), every token routed on the Floor
  (`routes(stock).pool != 0`, i.e. the Floor's own universe, no second list to govern),
  gross notional at Chainlink price ≤ `dailyCapUsd - usedToday` (cap accounted gross, as
  `DeskEngine.pilotCapUsdg`), optional single-name cap. Then `transferFrom(tba, …)` of the
  input, router call with `recipient = tba`, `deadline`; proceeds never touch the engine
  between calls. Emits `Executed(tokenId, agentId, action, notionalUsd, txHash-free data)`.
- ERC-8226-shaped views for anyone: `canExecute(agent, tokenId, action, amountUsd)` and
  `getMandate(tokenId)`.

Nothing here can send to an address other than the Broker's own wallet. The worst an
agent can do is trade badly inside the cap and pay the Floor fee (which goes to payroll).

### 3. Fees (COAT only, no new token, no new burn)

- **Hire fee**: the agent publishes `feeCoatPer30d`; at `hire` the owner prepays N periods
  from their own wallet (ERC-8191-style pull is v1). Split (settable): 90% to the agent,
  10% to `feeSink` = the existing Booster-side sink (buyback path). Zero new burn feature,
  in line with the single-burn-engine rule; COAT lock (bond) + COAT purchases (fees) are
  the pressure.
- **Floor fee**: unchanged 0.3%, 80% to payroll. Every agent trade pays holders.
- **Performance fee**: v1, only after the record exists (needs a high-water mark per
  mandate; not worth v0 complexity).

### 4. Record

- Indexer tracks `Executed` events, values each mandate's wallet daily at Chainlink prices,
  publishes per-agent and per-Broker returns net of Floor + hire fees vs (a) hold, (b)
  the live basket, (c) SPY-equivalent, 7/30/90d, same method as the basket scorecard.
- Published to the `data` branch with a hash; optional `RecordCommit` contract later.
- Leaderboard shows net-of-fees only, or it rewards churn.

## First-party agent and the outside door

- **Coattail Smart** registers as agent #1: the capped-smart signal, executed by our keeper
  as an ordinary agent (bond, fee, same caps). Day-one supply, and the honest benchmark.
- **MCP + skill**: publish a tiny MCP server / Virtuals ACP skill ("Agent Desk: list open
  mandates, read a Broker wallet, submit an order"). Claude/Codex/Grok users and Virtuals
  agents can be hired without touching Solidity. This is the fuel channel: builders with
  agents but no capital, meeting 1,776 wallets with capital but no agents.
- **Hire market on the site**: an *Agents* tab (copy `PlaybookPanel` reads; `agents.ts` from
  `playbooks.ts`): agent cards (record, fee, strategy text, bond), one-click hire, caps
  form, live mandate status, fire button. Public agent pages, shareable like the scorecard.

## Non-dilution Q&A (required by the primitive rule)

- **NFT devalue or bypass?** No. Only an active Broker can hire, and the capital is the
  Broker's own wallet; there is no way to bring an agent to Coattail without holding a
  Broker. Agent builders who want a record have to buy Brokers off the floor (the Geez
  pattern, now permissionless). Brokers with good agent records price above the floor.
- **COAT devalue or bypass?** No new fungible. Bonds lock COAT; hire fees are COAT bought
  through the hooked pool; the protocol share goes to the existing Booster-side sink;
  activation (burn) is still the only way to be eligible.
- **Payroll dilution?** None. Payroll is untouched; agent trades ADD Floor fees to it.
- **Custody?** Non-custodial: no contract ever holds Broker funds between transactions;
  the engine only moves value TBA → Floor → TBA inside one call.

## Risks and gates

- **Advisory optics**: an agent managing someone's stock wallet. Framing is the Robinhood
  Agentic Trading one: the owner selects the tool, sets the limits, can stop it at any
  time; we never pick an agent for anyone. Counsel one-pager before LIVE, same gate as Desk.
- **Robinhood policy risk**: Coinfello publicly showed agents bypass Robinhood's front-end
  geo-blocks by hitting stock-token contracts directly (Aug 2026). If Robinhood adds
  transfer-level restrictions to stock tokens (they can upgrade the issuer contracts),
  The Floor and every agent product on the chain are affected equally; Agent Desk adds no
  new exposure beyond what Playbooks already has.
- **Bad agents**: bounded by caps and the Floor; reputational risk handled by the record
  and by a curated "featured" list on the site (contracts stay permissionless).
- **Empty market**: mitigated by Coattail Smart on day one and the MCP door; the tab must
  not launch with zero agents.

## Estimate

| Week | Work |
|---|---|
| 1 | `AgentRegistry` + `MandateEngine`, unit tests, mainnet-fork tests against the deployed Floor (Fork*.t.sol pattern) |
| 2 | keeper: Coattail Smart as an agent; indexer: mandate record + leaderboard on `data` |
| 3 | frontend Agents tab + public agent pages; MCP server / ACP skill; docs |
| 4 | testnet full pass, counsel one-pager, mainnet with Coattail Smart only, then open registration |

All parameters settable (bond, cooldown, fee split, default caps, sink), no redeploy for tuning.

## Decisions needed from the owner

1. Outside agents from day one (permissionless registry) or first-party only for the first
   weeks? Recommendation: permissionless contracts, curated featured list, Coattail Smart
   live first.
2. Fee shape for v0: flat COAT per 30 days (recommended) vs performance fee (v1).
3. Bond size and cooldown (proposal: 50,000 COAT, 7 days).
4. Whether Playbooks and a mandate may coexist (proposal: no, one driver per Broker).
