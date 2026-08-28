# Coattail Brokers — frontend

Next.js **16.3.0**, React/DOM **19.2.8**, wagmi **3.7.6**, viem **2.55.15** and
React Query **5.101.4**. The wallet UI is project-owned; RainbowKit is not used.

## User flows

- **Mint** — closed by default; 0.001 ETH, primary cap 2, receipt-status checks and event-derived random token IDs.
- **Swap** — explicit `BUY · ETH → COAT` and `SELL · COAT → ETH` modes through `CoatRouter`.
  Buying never requests approval. Selling requests an exact COAT approval first, then a separate sell transaction.
  The sell field uses an unlocalized raw decimal amount and provides `MAX COAT`; formatted wallet
  balances must never be copied into a transaction field because locale separators are ambiguous.
- **Activate** — lists only NFTs owned by the connected account, burns COAT to activate,
  reads `Booster.claimable(tokenId)`, claims into the ERC-6551 wallet and transfers
  accumulated stock from that wallet.
- **Feed** — displays indexed strategy activity.
- **Docs** — mechanics, tokenomics, addresses and risk disclosures.

NFT cards read the canonical on-chain `tokenURI`; they do not use placeholder/test avatars. Owned
NFT discovery reads ERC-721 Transfer logs from the deployment block, with the NFT API and a bounded
on-chain scan only as fallbacks.

## Run locally

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` for WalletConnect. Injected wallets such
as MetaMask do not require it. A stale persisted wallet restore is released after three seconds so
the connect control is never disabled indefinitely.

## Configuration

- `NEXT_PUBLIC_NETWORK=testnet|mainnet` selects chain 46630 or 4663.
- Addresses and launch parameters: `src/lib/config.ts`.
- Chains/RPC fallback: `src/lib/chains.ts`.
- Contract ABIs: `src/lib/abis.ts`.
- Wallet connectors and persistence: `src/lib/wagmi.ts` and `src/app/providers.tsx`.
- `vercel.env.example` is the complete Vercel staging template. `UNUSUAL_WHALES_API_KEY` is the
  preferred server-only feed secret; `FMP_API_KEY` is its server-only fallback. Never set a deployer,
  keeper, owner or oracle private key in Vercel, and never prefix a secret with `NEXT_PUBLIC_`.

Mainnet builds intentionally fail when required addresses, pool/router data,
WalletConnect configuration or production-safe stock configuration is missing.

## Verification

```bash
npm run lint
npm test
npm run build
npm audit --omit=dev
```

The app is non-custodial: it prepares transactions that the user's wallet signs.
Receipt status must be `success` before any flow is shown as complete. `coattail.cash`
serves **mainnet** (`NEXT_PUBLIC_NETWORK=mainnet`); chain-46630 staging remains available
for testing. Core addresses come from `deployments.json` plus Vercel env; the two periphery
products carry their own config (`src/lib/floor.ts`, `src/lib/playbooks.ts`), each of which
hides its UI on a network where the contract address is empty. Full address list:
`../ADDRESSES.md`; live system state: `../STATUS.md`.
