"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { encodeFunctionData, formatUnits, isAddress, parseUnits, type Address } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { getCapabilities, sendCalls, waitForCallsStatus } from "wagmi/actions";
import { wagmiConfig } from "@/lib/wagmi";
import { ADDR, PARAMS } from "@/lib/config";
import { brokerAbi, brokerAccountAbi, claimSweeperAbi, coatAbi, boosterAbi, erc20Abi, strategyRegistryAbi } from "@/lib/abis";
import { activeChain } from "@/lib/chains";
import { useTx } from "@/lib/useTx";
import { client, waitForSuccessfulReceipt, txEvents } from "@/lib/client";
import { useOwnedBrokers } from "@/lib/useOwnedBrokers";
import { PlaybookPanel } from "@/components/PlaybookPanel";
import { useBrokerBacking } from "@/lib/useBrokerBacking";
import { useBrokerCoat } from "@/lib/useBrokerCoat";
import { useCoatPrice, usdLabel } from "@/lib/useCoatPrice";
import { loadKnownTokens, usd } from "@/lib/brokerValue";
import { fmt, short } from "@/lib/format";
import { BrokerArtwork } from "@/components/ui/BrokerArtwork";
import { Icon } from "@/components/ui/Icon";
import { StatusLine } from "@/components/ui/Status";
import { SIDE_PANEL_SLOT_ID } from "@/components/SidePanel";
import { StepFlow, type StepState } from "@/components/ui/StepFlow";
import { BrokerCard } from "@/components/ui/BrokerCard";
import { ShareOnX } from "@/components/ShareOnX";
import { useBrokerGifts } from "@/lib/useGifts";
import { nftAbi } from "@/lib/gifts";

type Info = { id: bigint; active: boolean; owner: `0x${string}`; wallet: `0x${string}` } | null;
type Holding = { token: Address; sym: string; bal: bigint; decimals: number; priceUsd?: number };

export function ActivateTab() {
  // The side panel mounts alongside this tab; its slot is looked up after mount and the
  // tools card is portalled there. Until then (and on the server) the card renders in place.
  const [sideSlot, setSideSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSideSlot(document.getElementById(SIDE_PANEL_SLOT_ID)); }, []);
  const portalTo = (node: React.ReactNode) => (sideSlot ? createPortal(node, sideSlot) : node);
  const { address } = useAccount();
  
  const { writeContractAsync } = useWriteContract();
  const act = useTx();
  const claimTx = useTx();
  const xfer = useTx();

  const [tokenId, setTokenId] = useState("");
  const [info, setInfo] = useState<Info>(null);
  // check() runs several rounds of reads; a newer check (a click on another Broker, or the
  // 20 s poll) must win, or a slow first Broker's holdings land under the second Broker's card
  // and Withdraw/Send would encode the wrong wallet and amount.
  const checkSeq = useRef(0);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [pending, setPending] = useState<{ sym: string; bal: bigint; decimals: number; priceUsd?: number }[]>([]);
  const [recipient, setRecipient] = useState("");
  const [selectedStock, setSelectedStock] = useState<Address | "">("");
  const [transferAmount, setTransferAmount] = useState("");
  const [steps, setSteps] = useState<StepState[]>(["idle", "idle"]);
  const [claimReadyCount, setClaimReadyCount] = useState(0);
  // Opt-in only: some holders withdraw every cent, and that's their call — never skip
  // value silently. Checking this trades sub-$0.50 balances for fewer signatures.
  const [skipDust, setSkipDust] = useState(false);
  const { brokers, loading: brokersLoading, reload: reloadBrokers } = useOwnedBrokers();

  useEffect(() => {
    // Never keep a Broker selected from a previously connected wallet.
    setInfo(null);
    setTokenId("");
    setHoldings([]);
    setPending([]);
    setSelectedStock("");
    setTransferAmount("");
  }, [address]);

  useEffect(() => {
    if (!info && brokers.length > 0) {
      const first = brokers.find((broker) => broker.active) ?? brokers[0];
      setTokenId(first.id.toString());
      void check(first.id.toString());
    }
  // `check` intentionally reads the freshest chain state when the owned list changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokers, info]);

  const { data: activeSharesData, refetch: refetchShares } = useReadContract({
    address: ADDR.booster, abi: boosterAbi, functionName: "activeShares",
  });
  const { data: coatBal, refetch: refetchCoat } = useReadContract({
    address: ADDR.coat, abi: coatAbi, functionName: "balanceOf",
    args: address ? [address] : undefined, query: { enabled: !!address },
  });
  const { data: burnData } = useReadContract({
    address: ADDR.broker, abi: brokerAbi, functionName: "ACTIVATION_BURN",
  });
  // activeSharesData stays subscribed for refetchShares(); the figure itself now
  // lives on Home — this tab shows only the visitor's own numbers.
  void activeSharesData;
  const price = useCoatPrice();
  const burnLabel = burnData !== undefined ? fmt(burnData as bigint, 18, 0) : PARAMS.activationBurn.toLocaleString();
  const burnUsdLabel = usdLabel(price.coatWeiToUsd(
    burnData !== undefined ? (burnData as bigint) : BigInt(PARAMS.activationBurn) * 10n ** 18n,
  ));
  const activeOwned = brokers.filter((item) => item.active === true).length;
  const backing = useBrokerBacking(brokers.map((b) => b.id));
  // Each Broker's own 6551 wallet address, so the card can offer one-tap copy
  // (people send stock/tips straight to a Broker). accountOf is a pure view and
  // the address never changes, so one fetch per owned id is enough.
  const [walletsById, setWalletsById] = useState<Record<string, string>>({});
  // Identity-stable: the panel keys its RPC effects on this, and a fresh array on every
  // render used to restart its (slow) valuation loop before it could ever finish.
  const brokersKey = brokers.map((b) => `${b.id}:${b.active}`).join(",");
  const playbookBrokers = useMemo(
    () => brokers.map((b) => ({ id: b.id, active: b.active })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [brokersKey],
  );
  const [coatReload, setCoatReload] = useState(0);
  const brokerCoat = useBrokerCoat(walletsById, coatReload);
  // NFT gifts drawn to these Brokers that are still inside their wallets (gift vault).
  const heldGifts = useBrokerGifts(brokers.map((b) => ({ id: b.id, wallet: walletsById[b.id.toString()] })), coatReload);
  const giftCountById = heldGifts.reduce<Record<string, number>>((acc, g) => {
    acc[g.brokerId] = (acc[g.brokerId] ?? 0) + 1;
    return acc;
  }, {});
  const holdingUsd = (h: { bal: bigint; decimals: number; priceUsd?: number }) =>
    h.priceUsd === undefined ? undefined : Number(formatUnits(h.bal, h.decimals)) * h.priceUsd;
  useEffect(() => {
    let stale = false;
    const missing = brokers.filter((b) => !walletsById[b.id.toString()]);
    if (missing.length === 0) return;
    Promise.all(
      missing.map(async (b) => {
        try {
          const w = await client.readContract({
            address: ADDR.broker, abi: brokerAbi, functionName: "accountOf", args: [b.id],
          });
          return [b.id.toString(), w as string] as const;
        } catch {
          return null;
        }
      }),
    ).then((pairs) => {
      if (stale) return;
      const found = pairs.filter((p): p is readonly [string, string] => p !== null);
      if (found.length > 0) setWalletsById((prev) => ({ ...prev, ...Object.fromEntries(found) }));
    });
    return () => { stale = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokers]);
  // counts only Brokers we positively read as off, so an unread one never inflates the
  // "activate all" cost or the burn it would ask for
  const inactiveOwned = brokers.filter((item) => item.active === false).length;
  const activateAllCost = burnData !== undefined ? (burnData as bigint) * BigInt(inactiveOwned) : undefined;
  const refetch = () => { refetchShares(); refetchCoat(); };

  const isOwner = !!(address && info && info.owner.toLowerCase() === address.toLowerCase());
  const coatBalBig = coatBal as bigint | undefined;
  const burnBig = burnData as bigint | undefined;
  const activateReason = !address
    ? "Connect your wallet."
    : !info
      ? "Check a Broker first."
      : !isOwner
        ? "You don't own this Broker."
        : info.active
          ? "Already active — it's earning."
          : coatBalBig !== undefined && burnBig !== undefined && coatBalBig < burnBig
            ? `Not enough $COAT — need ${burnLabel}. Buy some on the Floor tab.`
            : "";
  const canActivate = !!info && isOwner && !info.active && !activateReason;

  const setStep = (i: number, s: StepState) => setSteps((p) => p.map((v, j) => (j === i ? s : v)));

  function selectBroker(id: bigint) {
    setTokenId(id.toString());
    check(id.toString());
  }

  useEffect(() => {
    let cancelled = false;
    async function loadPortfolioPending() {
      let ready = 0;
      for (let offset = 0; offset < brokers.length; offset += 25) {
        const chunk = brokers.slice(offset, offset + 25);
        const results = await Promise.all(chunk.map((item) => client.readContract({
          address: ADDR.booster,
          abi: boosterAbi,
          functionName: "claimable",
          args: [item.id],
        }).catch(() => null)));
        ready += results.filter((result) => result?.[1].some((amount) => amount > 0n)).length;
        if (cancelled) return;
      }
      if (!cancelled) setClaimReadyCount(ready);
    }
    setClaimReadyCount(0);
    void loadPortfolioPending();
    return () => { cancelled = true; };
  }, [brokers]);

  // Silently revalidate the selected Broker's status, holdings and claimable so the
  // claim button and balances track keeper distributions without a page refresh.
  useEffect(() => {
    if (!info) return;
    const id = info.id.toString();
    const timer = setInterval(() => {
      if (!act.busy && !claimTx.busy && !xfer.busy) void check(id, { silent: true });
    }, 20_000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.id, act.busy, claimTx.busy, xfer.busy]);

  async function check(idStr?: string, opts?: { silent?: boolean }) {
    const silent = opts?.silent === true;
    const raw = idStr ?? tokenId;
    if (!raw) return silent ? undefined : act.setStatus("Enter a token id.", "err");
    const seq = ++checkSeq.current;
    const stale = () => seq !== checkSeq.current;
    try {
      const id = BigInt(raw);
      const [active, owner, wallet, basket, claimable] = await Promise.all([
        client.readContract({ address: ADDR.broker, abi: brokerAbi, functionName: "activated", args: [id] }),
        client.readContract({ address: ADDR.broker, abi: brokerAbi, functionName: "ownerOf", args: [id] }),
        client.readContract({ address: ADDR.broker, abi: brokerAbi, functionName: "accountOf", args: [id] }),
        client.readContract({ address: ADDR.strategyRegistry, abi: strategyRegistryAbi, functionName: "getBasket", args: [0n] }),
        client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "claimable", args: [id] }),
      ]);
      if (stale()) return;
      setInfo({ id, active, owner, wallet });
      if (!silent) act.setStatus(`Owner ${short(owner)}${address && owner.toLowerCase() === address.toLowerCase() ? " (you)" : ""}`);
      // Show every stock the Broker wallet can hold — the current basket plus every
      // token the Booster has ever bought (claimable[0] == knownTokens) — so stocks
      // claimed under an earlier basket don't vanish when the basket rotates.
      const seen = new Map<string, Address>();
      for (const token of [...basket[0], ...claimable[0]]) seen.set(token.toLowerCase(), token);
      const tokens = [...seen.values()];
      const balances = await Promise.all(tokens.map(async (token) => {
        const [bal, symbol, decimals] = await Promise.all([
          client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
          client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => short(token)),
          client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
        ]);
        return { token, sym: symbol, bal, decimals: Number(decimals) } satisfies Holding;
      }));
      // Price each holding from the Booster's own feeds so the wallet reads in dollars too.
      const metas = await loadKnownTokens(tokens).catch(() => []);
      if (stale()) return;
      const priced = balances.map((h) => ({
        ...h,
        priceUsd: metas.find((m) => m.token.toLowerCase() === h.token.toLowerCase())?.priceUsd,
      }));
      const nonZero = priced.filter((holding) => holding.bal > 0n);
      setHoldings(nonZero);
      setSelectedStock((current) => nonZero.some((holding) => holding.token === current) ? current : (nonZero[0]?.token ?? ""));
      setPending(claimable[0].map((token, i) => {
        const holding = priced.find((item) => item.token.toLowerCase() === token.toLowerCase());
        return { sym: holding?.sym ?? short(token), bal: claimable[1][i], decimals: holding?.decimals ?? 18, priceUsd: holding?.priceUsd };
      }).filter((h) => h.bal > 0n));
    } catch (e) {
      if (stale() || silent) return;
      // A revert (ownerOf on an unminted id) means the id is wrong; anything else is the RPC,
      // and telling a buyer "not found" during a rate-limit read as "this listing is fake".
      const name = String((e as { name?: string })?.name ?? "");
      if (/ContractFunction/i.test(name)) {
        act.setStatus("Token not found — is the id right?", "err");
        setInfo(null);
      } else {
        act.setStatus("Could not reach the chain just now — try again in a moment.", "err");
      }
    }
  }

  const activate = () =>
    act.run(async () => {
      if (!info) throw new Error("Press CHECK first.");
      if (!address || info.owner.toLowerCase() !== address.toLowerCase()) throw new Error("You don't own this Broker.");
      if (info.active) throw new Error("Already active.");
      const burn = (await client.readContract({
        address: ADDR.broker, abi: brokerAbi, functionName: "ACTIVATION_BURN",
      })) as bigint;
      const allowance = (await client.readContract({
        address: ADDR.coat, abi: coatAbi, functionName: "allowance", args: [address, ADDR.broker],
      })) as bigint;

      if (allowance < burn) {
        setStep(0, "doing");
        act.setStatus(`Approving ${fmt(burn, 18, 0)} $COAT for the burn…`);
        const ah = await writeContractAsync({
          address: ADDR.coat, abi: coatAbi, functionName: "approve", args: [ADDR.broker, burn], chainId: activeChain.id,
        });
        await waitForSuccessfulReceipt(ah);
      }
      setStep(0, "done");
      setStep(1, "doing");
      act.setStatus("Confirm activation (burns $COAT)…");
      const th = await writeContractAsync({
        address: ADDR.broker, abi: brokerAbi, functionName: "activate", args: [info.id], chainId: activeChain.id,
      });
      await waitForSuccessfulReceipt(th);
      setStep(1, "done");
      act.setStatus(`Broker #${info.id} is ACTIVE — it now earns the Congress basket.`, "ok");
      refetch();
      reloadBrokers();
      check(info.id.toString());
    });

  const activateAll = () =>
    act.run(async () => {
      if (!address) throw new Error("Connect your wallet.");
      // `active === false` only: an unread Broker (null) must not be pushed into a burn flow.
  const inactive = brokers.filter((item) => item.active === false);
      if (!inactive.length) throw new Error("Every owned Broker is already active.");
      const burn = (await client.readContract({
        address: ADDR.broker, abi: brokerAbi, functionName: "ACTIVATION_BURN",
      })) as bigint;
      const required = burn * BigInt(inactive.length);
      const balance = (await client.readContract({
        address: ADDR.coat, abi: coatAbi, functionName: "balanceOf", args: [address],
      })) as bigint;
      if (balance < required) throw new Error(`Not enough COAT — need ${fmt(required, 18, 0)}.`);
      const allowance = (await client.readContract({
        address: ADDR.coat, abi: coatAbi, functionName: "allowance", args: [address, ADDR.broker],
      })) as bigint;
      if (allowance < required) {
        act.setStatus(`Approve ${fmt(required, 18, 0)} COAT for ${inactive.length} Brokers…`);
        const approval = await writeContractAsync({
          address: ADDR.coat, abi: coatAbi, functionName: "approve", args: [ADDR.broker, required],
          chainId: activeChain.id,
        });
        await waitForSuccessfulReceipt(approval);
      }
      for (let i = 0; i < inactive.length; i += 1) {
        act.setStatus(`Activating ${i + 1}/${inactive.length}: Broker #${inactive[i].id}…`);
        const hash = await writeContractAsync({
          address: ADDR.broker, abi: brokerAbi, functionName: "activate", args: [inactive[i].id],
          chainId: activeChain.id,
        });
        await waitForSuccessfulReceipt(hash);
      }
      act.setStatus(`Activated ${inactive.length} Brokers. Each now earns one independent share.`, "ok");
      refetch();
      reloadBrokers();
    });

  // Claim ALL owned Brokers in one flow, using claimBatch (up to MAX_CLAIM_BATCH=5 Brokers per
  // tx). A holder with many Brokers signs one tx per 5, not one per Broker. Each claimBatch call
  // settles every earned token for every Broker in the batch into their wallets.
  // True when the connected wallet can execute a batch of calls behind ONE confirmation
  // (EIP-5792 atomic batching). Falls back to sequential signing everywhere else.
  const atomicSupported = async (): Promise<boolean> => {
    if (!address) return false;
    try {
      const caps = await getCapabilities(wagmiConfig, { account: address, chainId: activeChain.id });
      const forChain = (caps as Record<string | number, { atomic?: { status?: string } }>)[activeChain.id] ?? caps;
      const status = (forChain as { atomic?: { status?: string } })?.atomic?.status;
      // "supported": executes atomically today. "ready": can, after a wallet upgrade the
      // request may trigger. Either way the bundle below is sent with forceAtomic, so a wallet
      // that would run the calls one by one refuses instead of leaving a half-done sweep.
      return status === "supported" || status === "ready";
    } catch {
      return false;
    }
  };

  // The one-button answer to "let me claim everything at once": sweeps EVERY owned
  // Broker — claims what's still pending in the Booster and moves all stock out of each
  // Broker wallet into the connected wallet. On an EIP-5792 wallet the whole sweep is a
  // single confirmation; otherwise it runs the txs back-to-back with a progress counter.
  // claimBatch is capped at 5 ids per call on-chain, hence the chunking.
  const withdrawAll = () =>
    claimTx.run(async () => {
      if (!address) throw new Error("Connect your wallet.");
      if (brokers.length === 0) throw new Error("No Brokers in this wallet.");
      claimTx.setStatus("Scanning your Brokers…");

      const knownCount = Number(await client.readContract({
        address: ADDR.booster, abi: boosterAbi, functionName: "knownTokenCount",
      }));
      const knownTokens = (await Promise.all(
        Array.from({ length: knownCount }, (_, i) => client.readContract({
          address: ADDR.booster, abi: boosterAbi, functionName: "knownTokens", args: [BigInt(i)],
        })),
      )) as Address[];
      // Feed prices, to skip dust: TBAs accumulate cent-sized fractions across up to 128
      // tokens, and each withdrawal is its own owner-signed transaction — pure signature
      // waste. A token the feeds can't price is never skipped (we can't judge its value).
      const metas = await loadKnownTokens(knownTokens).catch(() => []);
      const usdOf = (token: Address, amount: bigint): number | null => {
        const m = metas.find((x) => x.token.toLowerCase() === token.toLowerCase());
        if (!m) return null;
        return Number(amount) / 10 ** m.decimals * m.priceUsd;
      };
      const DUST_USD = 0.5;
      let dustSkipped = 0;

      type Job = { wallet: Address; transfers: { token: Address; amount: bigint }[]; needsClaim: boolean; id: bigint };
      const jobs: Job[] = [];
      for (const b of brokers) {
        const [claim, wallet] = await Promise.all([
          client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "claimable", args: [b.id] }),
          client.readContract({ address: ADDR.broker, abi: brokerAbi, functionName: "accountOf", args: [b.id] }),
        ]);
        const claimByToken = new Map<string, bigint>();
        (claim[0] as readonly Address[]).forEach((token, i) => claimByToken.set(token.toLowerCase(), (claim[1] as readonly bigint[])[i]));
        const balances = await Promise.all(knownTokens.map((token) =>
          client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet as Address] })
            .then((v) => v as bigint).catch(() => 0n),
        ));
        const transfers: { token: Address; amount: bigint; valueUsd: number | null }[] = [];
        knownTokens.forEach((token, i) => {
          // Post-claim balance = current wallet balance + what the claim will move in.
          // claimable only grows until claimed, so this amount can never overshoot.
          const total = balances[i] + (claimByToken.get(token.toLowerCase()) ?? 0n);
          if (total <= 0n) return;
          const valueUsd = usdOf(token, total);
          if (skipDust && valueUsd !== null && valueUsd < DUST_USD) {
            dustSkipped += 1; // user opted in; the balance stays in the Broker wallet, still theirs
            return;
          }
          transfers.push({ token, amount: total, valueUsd });
        });
        transfers.sort((a, b) => (b.valueUsd ?? Infinity) - (a.valueUsd ?? Infinity));
        const needsClaim = (claim[1] as readonly bigint[]).some((amount) => amount > 0n);
        if (transfers.length > 0 || needsClaim) jobs.push({ id: b.id, wallet: wallet as Address, transfers, needsClaim });
      }
      if (jobs.length === 0) {
        claimTx.setStatus(dustSkipped > 0
          ? `Nothing worth withdrawing — ${dustSkipped} dust balance${dustSkipped > 1 ? "s" : ""} under $${DUST_USD} left in the Broker wallets.`
          : "Nothing to withdraw — your Brokers haven't accrued stock yet.", "ok");
        return;
      }

      const readyIds = jobs.filter((j) => j.needsClaim).map((j) => j.id);
      // With the sweeper, ALL pending claims collapse into one call; without it, the
      // Booster's claimBatch cap forces chunks of 5.
      const claimChunks: bigint[][] = [];
      if (ADDR.claimSweeper) {
        for (let i = 0; i < readyIds.length; i += 40) claimChunks.push(readyIds.slice(i, i + 40));
      } else {
        for (let i = 0; i < readyIds.length; i += 5) claimChunks.push(readyIds.slice(i, i + 5));
      }
      const claimCall = (ids: bigint[]) =>
        ADDR.claimSweeper
          ? { to: ADDR.claimSweeper, data: encodeFunctionData({ abi: claimSweeperAbi, functionName: "claimMany", args: [ids] }) }
          : { to: ADDR.booster, data: encodeFunctionData({ abi: boosterAbi, functionName: "claimBatch", args: [ids] }) };

      const calls = [
        ...claimChunks.map(claimCall),
        ...jobs.flatMap((j) => j.transfers.map((t) => ({
          to: j.wallet,
          data: encodeFunctionData({
            abi: brokerAccountAbi, functionName: "execute",
            args: [t.token, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [address, t.amount] }), 0],
          }),
        }))),
      ];

      const runSequential = async () => {
        const total = claimChunks.length + jobs.reduce((sum, j) => sum + j.transfers.length, 0);
        claimTx.setStatus(`This will take ${total} signature${total > 1 ? "s" : ""}`
          + (dustSkipped > 0 ? ` (${dustSkipped} dust balance${dustSkipped > 1 ? "s" : ""} under $${DUST_USD} skipped)` : "")
          + " — biggest values first, you can stop anytime…");
        let n = 0;
        for (const ids of claimChunks) {
          n += 1;
          claimTx.setStatus(`Tx ${n}/${total} — claiming ${ids.length} Broker${ids.length > 1 ? "s" : ""}…`);
          const h = ADDR.claimSweeper
            ? await writeContractAsync({
                address: ADDR.claimSweeper, abi: claimSweeperAbi, functionName: "claimMany",
                args: [ids], chainId: activeChain.id,
              })
            : await writeContractAsync({
                address: ADDR.booster, abi: boosterAbi, functionName: "claimBatch", args: [ids], chainId: activeChain.id,
              });
          await waitForSuccessfulReceipt(h);
        }
        for (const j of jobs) {
          for (const t of j.transfers) {
            n += 1;
            claimTx.setStatus(`Tx ${n}/${total} — withdrawing ${short(t.token)} from Broker #${j.id}…`);
            const transferCall = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [address, t.amount] });
            const h = await writeContractAsync({
              address: j.wallet, abi: brokerAccountAbi, functionName: "execute",
              args: [t.token, 0n, transferCall, 0], chainId: activeChain.id,
            });
            await waitForSuccessfulReceipt(h);
          }
        }
      };

      // Wallets cap one EIP-5792 bundle (seen in the wild: "The call bundle is too large for
      // the Wallet to process"). Send in bundles of BUNDLE calls, halve the bundle on a size
      // error, and if the wallet refuses even the first single-call bundle, sign one by one.
      const BUNDLE = 12;
      // On any failure, say what actually happened instead of guessing: re-read every planned
      // transfer's balance and count the ones that are gone from the Broker wallet.
      const describeMoved = async (): Promise<string> => {
        try {
          const planned = jobs.flatMap((j) => j.transfers.map((t) => ({ wallet: j.wallet, token: t.token, amount: t.amount })));
          const now = await Promise.all(planned.map((t) =>
            client.readContract({ address: t.token, abi: erc20Abi, functionName: "balanceOf", args: [t.wallet] }) as Promise<bigint>));
          const moved = planned.filter((t, k) => now[k] < t.amount).length;
          if (moved === 0) return "Nothing moved; your Brokers still hold everything.";
          if (moved === planned.length) return "Every withdrawal did land; refresh to see your wallet.";
          return `${moved} of ${planned.length} withdrawals landed before it stopped; the rest are still in the Broker wallets. Run it again to finish.`;
        } catch {
          return "Could not re-check balances; refresh before trying again.";
        }
      };
      let sentAll = false;
      if (calls.length > 1 && (await atomicSupported())) {
        let size = Math.min(BUNDLE, calls.length);
        let i = 0;
        let bundles = 0;
        while (i < calls.length) {
          const chunk = calls.slice(i, i + size);
          try {
            claimTx.setStatus(`Bundle ${bundles + 1}: ${chunk.length} step${chunk.length > 1 ? "s" : ""} in one confirmation (${calls.length - i} left)…`);
            // forceAtomic: the wallet must execute the whole bundle or none of it. A wallet that
            // can only run the calls one by one rejects the request, and we fall back to signing
            // one by one ourselves, which is honest about being non-atomic.
            const { id } = await sendCalls(wagmiConfig, { calls: chunk, chainId: activeChain.id, forceAtomic: true });
            claimTx.setStatus("Waiting for the bundle to confirm…");
            const result = await waitForCallsStatus(wagmiConfig, { id, timeout: 180_000 });
            // A bundle has no hash of its own until it lands; link the receipt it produced.
            const landed = result.receipts?.[result.receipts.length - 1]?.transactionHash;
            if (landed) txEvents.dispatchEvent(new CustomEvent("sent", { detail: landed }));
            if (result.status !== "success") {
              throw new Error(`The bundle did not complete. ${await describeMoved()}`);
            }
            i += chunk.length;
            bundles += 1;
          } catch (e) {
            const msg = String((e as { shortMessage?: string; message?: string })?.shortMessage
              || (e as { message?: string })?.message || e);
            const rejected = /rejected|denied/i.test(msg);
            const tooLarge = /too large|bundle|batch/i.test(msg) && !rejected;
            const notAtomic = /atomic|not supported|unsupported|5792|method/i.test(msg) && !rejected;
            if (tooLarge && size > 1) { size = Math.max(1, Math.floor(size / 2)); continue; }
            if ((tooLarge || notAtomic) && i === 0) break; // cannot bundle atomically: sign one by one
            if (/timed? ?out|timeout/i.test(msg)) {
              throw new Error(`The bundle was not confirmed within 3 minutes. ${await describeMoved()}`);
            }
            if (/did not complete/.test(msg)) throw e;
            throw new Error(`${msg} ${await describeMoved()}`);
          }
        }
        sentAll = i >= calls.length;
      }
      if (!sentAll) await runSequential();
      claimTx.setStatus(`Done — stock from ${jobs.length} Broker${jobs.length > 1 ? "s" : ""} is in your wallet`
        + (dustSkipped > 0 ? ` (${dustSkipped} sub-$${DUST_USD} dust balance${dustSkipped > 1 ? "s" : ""} left behind on purpose).` : "."), "ok");
      refetch();
      reloadBrokers();
    });

  const claimAll = () =>
    claimTx.run(async () => {
      if (!address) throw new Error("Connect your wallet.");
      // Fresh read of which Brokers actually have something to claim.
      const ready: bigint[] = [];
      for (let offset = 0; offset < brokers.length; offset += 25) {
        const chunk = brokers.slice(offset, offset + 25);
        const results = await Promise.all(chunk.map((b) => client.readContract({
          address: ADDR.booster, abi: boosterAbi, functionName: "claimable", args: [b.id],
        }).catch(() => null)));
        chunk.forEach((b, i) => {
          const r = results[i];
          if (r && r[1].some((amount) => amount > 0n)) ready.push(b.id);
        });
      }
      if (ready.length === 0) {
        claimTx.setStatus("Nothing to claim — earned stock is already in your Broker wallets.", "ok");
        return;
      }
      // One REAL transaction for any number of Brokers: the ClaimSweeper periphery loops
      // the Booster's permissionless claimFor, sidestepping claimBatch's 5-id cap. Chunked
      // at 40 ids purely as a block-gas safety margin (~200k gas per claimed Broker).
      if (ADDR.claimSweeper) {
        const chunks: bigint[][] = [];
        for (let i = 0; i < ready.length; i += 40) chunks.push(ready.slice(i, i + 40));
        let done = 0;
        for (const chunk of chunks) {
          claimTx.setStatus(chunks.length === 1
            ? `Claiming all ${ready.length} Broker${ready.length > 1 ? "s" : ""} in one transaction…`
            : `Claiming Brokers ${done + 1}–${done + chunk.length} of ${ready.length}…`);
          const h = await writeContractAsync({
            address: ADDR.claimSweeper, abi: claimSweeperAbi, functionName: "claimMany",
            args: [chunk], chainId: activeChain.id,
          });
          await waitForSuccessfulReceipt(h);
          done += chunk.length;
        }
      } else {
        // No sweeper on this network — fall back to the Booster's capped claimBatch.
        const batches: bigint[][] = [];
        for (let i = 0; i < ready.length; i += 5) batches.push(ready.slice(i, i + 5));
        let done = 0;
        for (const batch of batches) {
          claimTx.setStatus(`Claiming Brokers ${done + 1}–${done + batch.length} of ${ready.length}…`);
          const h = await writeContractAsync({
            address: ADDR.booster, abi: boosterAbi, functionName: "claimBatch", args: [batch], chainId: activeChain.id,
          });
          await waitForSuccessfulReceipt(h);
          done += batch.length;
        }
      }
      claimTx.setStatus(`Claimed ${ready.length} Broker${ready.length > 1 ? "s" : ""} into their wallets.`, "ok");
      refetch();
      reloadBrokers();
    });

  // Claim = pull accrued stock from the Booster into the Broker's own ERC-6551 wallet.
  // A single tx that settles every token at once; the stock then lives in the Broker
  // wallet and travels with the NFT. This is the normal, one-signature path.
  const claimOnly = () =>
    claimTx.run(async () => {
      if (!info) throw new Error("Check a Broker first.");
      if (!address || !isOwner) throw new Error("You don't own this Broker.");
      if (!hasClaimable) {
        claimTx.setStatus("Nothing to claim — earned stock is already in your Broker wallet.", "ok");
        return;
      }
      claimTx.setStatus("Claiming accrued stock into your Broker wallet…");
      const c = await writeContractAsync({
        address: ADDR.booster, abi: boosterAbi, functionName: "claim", args: [info.id], chainId: activeChain.id,
      });
      await waitForSuccessfulReceipt(c);
      claimTx.setStatus("Claimed — your stock is in your Broker wallet.", "ok");
      refetch();
      reloadBrokers();
      check(info.id.toString());
    });

  // Withdraw = get earned stock all the way into the connected wallet. The keeper
  // already claims Booster → Broker wallet automatically; this button first claims
  // anything still pending, then moves the Broker wallet's stock out to the holder.
  // Optional/advanced: this sends one transfer tx per token, since the ERC-6551 account
  // executes a single call per tx. Most holders never need it — the stock is already
  // theirs, held in the Broker wallet that moves with the NFT.
  const withdraw = () =>
    claimTx.run(async () => {
      if (!info) throw new Error("Check a Broker first.");
      if (!address || !isOwner) throw new Error("You don't own this Broker.");
      if (hasClaimable) {
        claimTx.setStatus("Claiming accrued stock into the Broker wallet…");
        const c = await writeContractAsync({
          address: ADDR.booster, abi: boosterAbi, functionName: "claim", args: [info.id], chainId: activeChain.id,
        });
        await waitForSuccessfulReceipt(c);
      }
      // Re-read the Broker wallet's balances (post-claim) across every known token.
      const [basketNow, claimableNow] = await Promise.all([
        client.readContract({ address: ADDR.strategyRegistry, abi: strategyRegistryAbi, functionName: "getBasket", args: [0n] }),
        client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "claimable", args: [info.id] }),
      ]);
      const seen = new Map<string, Address>();
      for (const token of [...basketNow[0], ...claimableNow[0]]) seen.set(token.toLowerCase(), token);
      let moved = 0;
      for (const token of seen.values()) {
        const bal = (await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [info.wallet] })) as bigint;
        if (bal <= 0n) continue;
        moved += 1;
        claimTx.setStatus(`Withdrawing ${short(token)} to your wallet…`);
        const transferCall = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [address, bal] });
        const h = await writeContractAsync({
          address: info.wallet, abi: brokerAccountAbi, functionName: "execute",
          args: [token, 0n, transferCall, 0], chainId: activeChain.id,
        });
        await waitForSuccessfulReceipt(h);
      }
      claimTx.setStatus(moved ? `Withdrew ${moved} stock${moved > 1 ? "s" : ""} to your wallet.` : "Nothing to withdraw yet.", "ok");
      refetch();
      reloadBrokers();
      check(info.id.toString());
    });

  // COAT inside a Broker wallet is spendable only from the owner's wallet (activation
  // burns from msg.sender), so it gets its own one-signature exit.
  const withdrawCoat = () =>
    claimTx.run(async () => {
      if (!info) throw new Error("Check a Broker first.");
      if (!address || !isOwner) throw new Error("You don't own this Broker.");
      const bal = (await client.readContract({ address: ADDR.coat, abi: coatAbi, functionName: "balanceOf", args: [info.wallet] })) as bigint;
      if (bal <= 0n) throw new Error("No $COAT in this Broker's wallet.");
      claimTx.setStatus(`Moving ${fmt(bal, 18, 0)} $COAT from Broker #${info.id} to your wallet…`);
      const transferCall = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [address, bal] });
      const h = await writeContractAsync({
        address: info.wallet, abi: brokerAccountAbi, functionName: "execute",
        args: [ADDR.coat, 0n, transferCall, 0], chainId: activeChain.id,
      });
      await waitForSuccessfulReceipt(h);
      claimTx.setStatus(`${fmt(bal, 18, 0)} $COAT is in your wallet.`, "ok");
      setCoatReload((n) => n + 1);
      refetch();
    });

  // A gifted NFT sits in the Broker wallet like everything else; the owner moves it out
  // with one execute call (safeTransferFrom signed by the wallet itself).
  const withdrawGift = (nft: Address, id: string) =>
    claimTx.run(async () => {
      if (!info) throw new Error("Check a Broker first.");
      if (!address || !isOwner) throw new Error("You don't own this Broker.");
      claimTx.setStatus(`Moving the gift out of Broker #${info.id} to your wallet…`);
      const call = encodeFunctionData({ abi: nftAbi, functionName: "safeTransferFrom", args: [info.wallet, address, BigInt(id)] });
      const h = await writeContractAsync({
        address: info.wallet, abi: brokerAccountAbi, functionName: "execute",
        args: [nft, 0n, call, 0], chainId: activeChain.id,
      });
      await waitForSuccessfulReceipt(h);
      claimTx.setStatus("The gift is in your wallet.", "ok");
      setCoatReload((n) => n + 1);
    });

  const selectedHolding = holdings.find((holding) => holding.token === selectedStock);

  const transferStock = () =>
    xfer.run(async () => {
      if (!info) throw new Error("Check a Broker first.");
      if (!isOwner) throw new Error("You don't own this Broker.");
      if (!isAddress(recipient)) throw new Error("Enter a valid recipient address.");
      if (!selectedHolding) throw new Error("Select a stock first.");
      const amount = parseUnits(transferAmount, selectedHolding.decimals);
      if (amount <= 0n || amount > selectedHolding.bal) throw new Error("Enter an amount within the available balance.");
      const transferCall = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [recipient as Address, amount],
      });
      xfer.setStatus(`Sending ${transferAmount} ${selectedHolding.sym} from Broker #${info.id}…`);
      const h = await writeContractAsync({
        address: info.wallet, abi: brokerAccountAbi, functionName: "execute",
        args: [selectedHolding.token, 0n, transferCall, 0], chainId: activeChain.id,
      });
      await waitForSuccessfulReceipt(h);
      xfer.setStatus(`${transferAmount} ${selectedHolding.sym} sent from the Broker wallet.`, "ok");
      setTransferAmount("");
      await check(info.id.toString());
    });

  const hasClaimable = pending.length > 0;

  const selectedGifts = info ? heldGifts.filter((g) => g.brokerId === info.id.toString()) : [];
  const selectedCoat = info ? (brokerCoat.byId[info.id.toString()] ?? 0n) : 0n;
  const offOwned = brokers.length - activeOwned;

  return (
    <div className="grid gap-5">
      {/* ── 1. The portfolio: the numbers that matter, then the list. Nothing else here. ── */}
      <div className="card">
        <div className="flex items-center justify-between mb-1">
          <h2 className="pixel-title text-[15px]">My Brokers</h2>
          {address && (
            <button className="text-ink-soft hover:text-accent" onClick={reloadBrokers} aria-label="refresh">
              <Icon name="search" className="w-4 h-4" />
            </button>
          )}
        </div>
        {!address ? (
          <p className="text-ink-soft text-sm">Connect your wallet to see your Brokers.</p>
        ) : (
          <>
            <p className="text-ink-soft text-sm mb-4">
              Every active Broker earns real tokenized stock into its own wallet, about once an hour,
              with nothing for you to do. Tap a Broker to open it.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-4">
              <Stat
                k="Earned since switch-on"
                v={backing.totalEarnedUsd !== null && backing.totalEarnedUsd > 0 ? usd(backing.totalEarnedUsd) : "—"}
                sub="never shrinks when you withdraw"
                cls="text-good"
              />
              <Stat
                k="Stock inside"
                v={backing.totalUsd !== null && brokers.length > 0 ? usd(backing.totalUsd) : "—"}
                sub="in Broker wallets + claimable"
              />
              <Stat k="Brokers" v={brokers.length ? `${activeOwned} on · ${offOwned} off` : "0"} sub={claimReadyCount > 0 ? `${claimReadyCount} ready to claim` : undefined} />
              <Stat k="Your $COAT" v={fmt(coatBal as bigint | undefined, 18, 0)} sub={usdLabel(price.coatWeiToUsd(coatBal as bigint | undefined))} cls="text-accent" />
            </div>
            {brokerCoat.total > 0n && (
              <p className="text-[12px] text-ink-soft mb-3">
                <b className="text-accent">{fmt(brokerCoat.total, 18, 0)} $COAT</b> ({usdLabel(price.coatWeiToUsd(brokerCoat.total))}) is
                sitting inside your Brokers. Open one to withdraw it.
              </p>
            )}
            {brokersLoading ? (
              <p className="text-ink-soft text-sm">Loading…</p>
            ) : brokers.length === 0 ? (
              <p className="text-ink-soft text-sm">No Brokers in this wallet — get one on OpenSea first.</p>
            ) : (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-2.5">
                {brokers.map((b) => (
                  <BrokerCard key={b.id.toString()} id={b.id} active={b.active} selected={tokenId === b.id.toString()} onSelect={() => selectBroker(b.id)} backingUsd={backing.byId[b.id.toString()]} earnedUsd={backing.earnedById[b.id.toString()]} wallet={walletsById[b.id.toString()]} coatInside={brokerCoat.byId[b.id.toString()]} giftCount={giftCountById[b.id.toString()]} />
                ))}
              </div>
            )}
            {/* The two bulk buttons people actually reach for, right under the list. */}
            {brokers.length > 0 && (inactiveOwned > 1 || claimReadyCount > 0) && (
              <div className="grid sm:grid-cols-2 gap-2 mt-3">
                {claimReadyCount > 0 && (
                  <button className="btn btn-accent w-full" onClick={claimAll} disabled={claimTx.busy}>
                    <Icon name="download" /> {claimTx.busy ? "CLAIMING…" : `CLAIM ALL (${claimReadyCount})`}
                  </button>
                )}
                {inactiveOwned > 1 && (
                  <button className="btn btn-ghost w-full" onClick={activateAll} disabled={act.busy}>
                    <Icon name="power" /> ACTIVATE ALL ({inactiveOwned}
                    {activateAllCost !== undefined ? ` · ${fmt(activateAllCost, 18, 0)} COAT` : ""})
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── 2. The open Broker: one card, top to bottom = switch on → what's inside → claim → extras ── */}
      {info && (
        <div className="card border-l-[3px] border-l-accent">
          <div className="flex items-center gap-3 mb-3">
            <div className="border border-line bg-cream shrink-0">
              <BrokerArtwork tokenId={info.id} size={72} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-pixel text-sm text-ink-strong">Broker #{info.id.toString()}</span>
                <span className={`badge ${info.active ? "border-good text-good" : "border-ink-soft text-ink-soft"}`}>
                  {info.active ? "ACTIVE" : "INACTIVE"}
                </span>
                {!isOwner && <span className="badge border-ink-soft text-ink-soft">not yours</span>}
              </div>
              <div className="flex items-center gap-2 text-sm mt-1">
                <span className="text-ink-soft">wallet:</span>
                <code className="font-pixel text-[11px]">{short(info.wallet)}</code>
                <button
                  className="font-mono text-[10px] border border-line px-1.5 py-0.5 text-ink-soft hover:text-ink-strong hover:border-ink transition-colors"
                  title="Copy this Broker's wallet address"
                  onClick={async () => {
                    // Report "copied" only once the write resolved; a denied clipboard
                    // permission used to show success while nothing was copied.
                    try {
                      if (!navigator.clipboard) throw new Error("clipboard unavailable");
                      await navigator.clipboard.writeText(info.wallet);
                      act.setStatus(`Broker #${info.id} wallet copied: ${info.wallet}`, "ok");
                    } catch {
                      act.setStatus(`Could not copy. Select the address by hand: ${info.wallet}`, "err");
                    }
                  }}
                >
                  copy ⧉
                </button>
              </div>
              {backing.earnedById[info.id.toString()] !== undefined && (
                <div className="text-[12px] text-ink-soft mt-1">
                  Earned <b className="text-good">{usd(backing.earnedById[info.id.toString()])}</b> since you switched it on.
                </div>
              )}
            </div>
          </div>

          {/* Switch on — the only thing an inactive Broker needs */}
          {isOwner && !info.active && (
            <div className="border-t border-line pt-3 mb-3">
              <p className="text-ink-soft text-sm mb-2">
                This Broker is switched off, so it earns nothing yet. Activating burns {burnLabel} $COAT
                {price.ready ? ` (≈ ${burnUsdLabel})` : ""} once; from then on it earns a share of every purchase.
              </p>
              <button className="btn btn-accent w-full" onClick={activate} disabled={act.busy || !canActivate}>
                <Icon name="power" /> {act.busy ? "WORKING…" : `ACTIVATE #${info.id.toString()}`}
              </button>
              {activateReason && <p className="text-accent text-sm mt-2">{activateReason}</p>}
              <StepFlow steps={[{ label: "approve COAT", state: steps[0] }, { label: "activate", state: steps[1] }]} />
              <StatusLine msg={act.msg} kind={act.kind} hash={act.hash} />
            </div>
          )}

          {/* What's inside the wallet right now */}
          <div className="border-t border-line pt-3">
            <div className="label">Inside this Broker&rsquo;s wallet</div>
            {holdings.length === 0 && selectedCoat === 0n && selectedGifts.length === 0 && (
              <p className="text-ink-soft text-sm">
                {info.active ? "Nothing claimed yet — earned stock lands here about once an hour." : "Empty. Switch it on to start earning."}
              </p>
            )}
            {holdings.length > 0 && (
              <div className="grid gap-1.5">
                {holdings.map((h) => (
                  <div key={h.token} className="flex items-center gap-3">
                    <span className="badge">{h.sym}</span>
                    <span className="font-pixel text-sm">{fmt(h.bal, h.decimals, 7)}</span>
                    <span className="text-[12px] text-ink-soft tabular-nums">{usdLabel(holdingUsd(h))}</span>
                  </div>
                ))}
              </div>
            )}
            {selectedCoat > 0n && (
              <div className="flex items-center gap-3 mt-2">
                <span className="badge border-accent text-accent">$COAT</span>
                <span className="font-pixel text-sm">{fmt(selectedCoat, 18, 0)}</span>
                <span className="text-[12px] text-ink-soft tabular-nums">{usdLabel(price.coatWeiToUsd(selectedCoat))}</span>
                {isOwner && (
                  <button className="btn btn-ghost text-[10px] px-2 py-1.5 ml-auto" onClick={withdrawCoat} disabled={claimTx.busy} type="button">
                    Withdraw
                  </button>
                )}
              </div>
            )}
            {selectedGifts.map((g) => (
              <div key={`${g.nft}:${g.id}`} className="flex items-center gap-3 mt-2">
                {g.nft.toLowerCase() === ADDR.broker.toLowerCase() && (
                  <div className="border border-line bg-cream shrink-0"><BrokerArtwork tokenId={BigInt(g.id)} size={32} /></div>
                )}
                <span className="badge border-accent text-accent">{g.name} #{g.id}</span>
                <span className="text-[11px] text-ink-soft">gift draw win</span>
                {isOwner && (
                  <button className="btn btn-ghost text-[10px] px-2 py-1.5 ml-auto" onClick={() => withdrawGift(g.nft, g.id)} disabled={claimTx.busy} type="button">
                    Withdraw
                  </button>
                )}
              </div>
            ))}
            <p className="text-[11px] text-ink-soft mt-2">Everything here travels with the NFT if you sell it.</p>
          </div>

          {/* Still accruing in the engine */}
          {pending.length > 0 && (
            <div className="border-t border-line pt-3 mt-3">
              <div className="label">Earned, not claimed yet</div>
              {pending.map((h) => (
                <div key={h.sym} className="text-sm">
                  {h.sym}: {fmt(h.bal, h.decimals, 4)}
                  <span className="text-ink-soft text-[12px] ml-2 tabular-nums">{usdLabel(holdingUsd(h))}</span>
                </div>
              ))}
              <p className="text-[11px] text-ink-soft mt-1">Claims itself about once an hour. Claim now if you don&rsquo;t want to wait.</p>
              {isOwner && (
                <button className="btn btn-accent w-full mt-2" onClick={claimOnly} disabled={claimTx.busy}>
                  <Icon name="download" /> {claimTx.busy ? "CLAIMING…" : "CLAIM NOW"}
                </button>
              )}
            </div>
          )}

          {/* Take it out / show it off */}
          {isOwner && (holdings.length > 0 || hasClaimable) && (
            <button className="btn btn-ghost w-full mt-3" onClick={withdraw} disabled={claimTx.busy}>
              <Icon name="wallet" /> {claimTx.busy ? "WITHDRAWING…" : "Withdraw stock to my wallet"}
            </button>
          )}
          <StatusLine msg={claimTx.msg} kind={claimTx.kind} hash={claimTx.hash} />
          {isOwner && (
            <ShareOnX data={{
              id: info.id.toString(),
              active: info.active,
              earnedUsd: backing.earnedById[info.id.toString()],
              backingUsd: backing.byId[info.id.toString()],
              coatInside: selectedCoat,
              coatUsd: price.coatWeiToUsd(selectedCoat),
              symbols: holdings.map((h) => h.sym),
              gifts: giftCountById[info.id.toString()],
            }} />
          )}

          {isOwner && holdings.length > 0 && (
            <details className="group mt-3 border-t border-line pt-3">
              <summary className="btn btn-ghost w-full justify-between cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                <span><Icon name="arrow-right" /> Send stock from this Broker to another address</span>
                <span className="transition-transform group-open:rotate-90">▶</span>
              </summary>
              <p className="text-ink-soft text-sm mt-2 mb-2">
                The Broker NFT stays with you and remains active.
              </p>
              <div className="grid sm:grid-cols-2 gap-2 mb-2">
                <select
                  className="fld font-pixel text-[12px]"
                  value={selectedStock}
                  onChange={(event) => {
                    setSelectedStock(event.target.value as Address);
                    setTransferAmount("");
                  }}
                  disabled={!holdings.length}
                >
                  {holdings.map((holding) => (
                    <option key={holding.token} value={holding.token}>
                      {holding.sym} · {fmt(holding.bal, holding.decimals, 7)}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <input
                    className="fld font-pixel text-[12px]"
                    inputMode="decimal"
                    placeholder="Amount"
                    value={transferAmount}
                    onChange={(event) => setTransferAmount(event.target.value.replace(/[^0-9.]/g, ""))}
                  />
                  <button
                    className="btn btn-ghost px-3"
                    type="button"
                    disabled={!selectedHolding}
                    onClick={() => selectedHolding && setTransferAmount(
                      formatUnits(selectedHolding.bal, selectedHolding.decimals),
                    )}
                  >
                    MAX
                  </button>
                </div>
              </div>
              <div className="flex gap-2">
                <input
                  className="fld font-pixel text-[12px]"
                  placeholder="0xrecipient…"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value.trim())}
                />
                <button className="btn btn-ghost shadow-pixel-sm" onClick={transferStock} disabled={xfer.busy || !isAddress(recipient) || !selectedHolding || !transferAmount}>
                  <Icon name="arrow-right" /> SEND
                </button>
              </div>
              <StatusLine msg={xfer.msg} kind={xfer.kind} hash={xfer.hash} />
            </details>
          )}
        </div>
      )}
      {!info && <StatusLine msg={act.msg} kind={act.kind} hash={act.hash} />}
      {!info && <StatusLine msg={claimTx.msg} kind={claimTx.kind} hash={claimTx.hash} />}

      {/* ── 3. Playbooks: standing orders the hourly engine executes per Broker ── */}
      <PlaybookPanel
        brokers={playbookBrokers}
        walletsById={walletsById as Record<string, `0x${string}` | undefined>}
      />

      {/* ── 4. Everything at once + power tools: at the top of the side panel, out of the
             portfolio's way. The card keeps this component's state, so it is portalled into
             the panel's slot rather than rebuilt there; before the slot exists it stays in
             the flow here, so nothing depends on render order. ── */}
      {address && portalTo((
        <div className="card !p-4">
          <h2 className="font-pixel text-[11px] text-ink-strong mb-1">More tools</h2>
          <p className="text-ink-soft text-[12px] mb-3">Nothing here is required. Your stock is already yours inside each Broker.</p>
          {brokers.length > 0 && (
            <details className="group mt-1">
              <summary className="btn btn-ghost w-full justify-between cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                <span><Icon name="wallet" /> Withdraw everything to my wallet</span>
                <span className="transition-transform group-open:rotate-90">▶</span>
              </summary>
              <div className="mt-2 grid gap-2">
                <button className="btn btn-ghost w-full" onClick={withdrawAll} disabled={claimTx.busy}>
                  <Icon name="wallet" /> {claimTx.busy ? "WORKING…" : "WITHDRAW EVERYTHING TO MY WALLET"}
                </button>
                <label className="flex items-center gap-2 text-[12px] text-ink-soft cursor-pointer select-none">
                  <input type="checkbox" checked={skipDust} onChange={(e) => setSkipDust(e.target.checked)}
                    className="accent-[var(--c-accent)]" />
                  Skip balances under $0.50 (fewer signatures — they stay in the Broker wallet, still yours)
                </label>
                <p className="text-[11px] text-ink-soft">
                  Claims every Broker, then moves all stock into your connected wallet — you see the
                  total signature count before the first prompt. Batching wallets sign once.
                </p>
              </div>
            </details>
          )}
          <details className="group mt-2">
            <summary className="btn btn-ghost w-full justify-between cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <span><Icon name="search" /> Look up any Broker by id</span>
              <span className="transition-transform group-open:rotate-90">▶</span>
            </summary>
            <div className="flex gap-2 mt-2">
              <input
                className="fld"
                inputMode="numeric"
                placeholder="e.g. 1"
                value={tokenId}
                onChange={(e) => setTokenId(e.target.value.replace(/\D/g, ""))}
              />
              <button className="btn btn-ghost shadow-pixel-sm" onClick={() => check()}>
                <Icon name="search" /> CHECK
              </button>
            </div>
          </details>
        </div>
      ))}
    </div>
  );
}

function Stat({ k, v, sub, cls = "text-ink-strong" }: { k: string; v: string; sub?: string; cls?: string }) {
  return (
    <div className="stat">
      <div className="text-[11px] text-ink-soft uppercase tracking-widest">{k}</div>
      <div className={`font-pixel text-lg mt-1 break-words ${cls}`}>{v}</div>
      {sub && <div className="text-[11px] text-ink-soft mt-0.5 tabular-nums">{sub}</div>}
    </div>
  );
}
