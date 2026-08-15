# Coattail Brokers — frontend

Next.js **16.3.0**, React/DOM **19.2.8**, wagmi **3.7.6**, viem **2.55.15** and
React Query **5.101.4**. The wallet UI is project-owned; RainbowKit is not used.

## User flows

- **Mint** — closed by default; flat 0.0015 ETH, primary cap 2, receipt-status checks and event-derived random token IDs.
- **Swap** — ETH ↔ COAT through the configured `CoatRouter` with quotes and minimum output.
- **Activate** — lists only NFTs owned by the connected account, burns COAT to activate,
  reads `Booster.claimable(tokenId)`, claims into the ERC-6551 wallet and transfers
  accumulated stock from that wallet.
- **Feed** — displays indexed strategy activity.
- **Docs** — mechanics, tokenomics, addresses and risk disclosures.

The local preview is deterministic. Production metadata switches to the audited canonical
renderer payload only after all 1,776 bitmap/trait hashes are uploaded and verified.

## Run locally

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` for WalletConnect. Injected wallets such
as MetaMask do not require it. Wallet state is persisted with wagmi cookie storage
and restored through the server-provided initial state.

## Configuration

- `NEXT_PUBLIC_NETWORK=testnet|mainnet` selects chain 46630 or 4663.
- Addresses and launch parameters: `src/lib/config.ts`.
- Chains/RPC fallback: `src/lib/chains.ts`.
- Contract ABIs: `src/lib/abis.ts`.
- Wallet connectors and persistence: `src/lib/wagmi.ts` and `src/app/providers.tsx`.

Mainnet builds intentionally fail when required addresses, pool/router data,
WalletConnect configuration or production-safe stock configuration is missing.

## Verification

```bash
npm run lint
npm test
npm run build
npm run test:e2e
npm audit --omit=dev
```

The app is non-custodial: it prepares transactions that the user's wallet signs.
Receipt status must be `success` before any flow is shown as complete. No current
mainnet deployment is promoted. The active chain-46630 staging addresses are in
`deployments.json` and `../ADDRESSES.md`; `coattail.cash` must use
`NEXT_PUBLIC_NETWORK=testnet` until the mainnet gates in `../STATUS.md` pass.
