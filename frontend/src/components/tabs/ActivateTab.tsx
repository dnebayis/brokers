"use client";

import { useEffect, useState } from "react";
import { encodeFunctionData, formatUnits, isAddress, parseUnits, type Address } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { getCapabilities, sendCalls, waitForCallsStatus } from "wagmi/actions";
import { wagmiConfig } from "@/lib/wagmi";
import { ADDR, PARAMS } from "@/lib/config";
import { brokerAbi, brokerAccountAbi, coatAbi, boosterAbi, erc20Abi, strategyRegistryAbi } from "@/lib/abis";
import { activeChain } from "@/lib/chains";
import { useTx } from "@/lib/useTx";
import { client, waitForSuccessfulReceipt } from "@/lib/client";
import { useOwnedBrokers } from "@/lib/useOwnedBrokers";
import { useBrokerBacking } from "@/lib/useBrokerBacking";
import { usd } from "@/lib/brokerValue";
import { fmt, short } from "@/lib/format";
import { BrokerArtwork } from "@/components/ui/BrokerArtwork";
import { Icon } from "@/components/ui/Icon";
import { StatusLine } from "@/components/ui/Status";
import { StepFlow, type StepState } from "@/components/ui/StepFlow";
import { BrokerCard } from "@/components/ui/BrokerCard";

type Info = { id: bigint; active: boolean; owner: `0x${string}`; wallet: `0x${string}` } | null;
type Holding = { token: Address; sym: string; bal: bigint; decimals: number };

export function ActivateTab() {
  const { address } = useAccount();
  
  const { writeContractAsync } = useWriteContract();
  const act = useTx();
  const claimTx = useTx();
  const xfer = useTx();

  const [tokenId, setTokenId] = useState("");
  const [info, setInfo] = useState<Info>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [pending, setPending] = useState<{ sym: string; bal: bigint }[]>([]);
  const [recipient, setRecipient] = useState("");
  const [selectedStock, setSelectedStock] = useState<Address | "">("");
  const [transferAmount, setTransferAmount] = useState("");
  const [steps, setSteps] = useState<StepState[]>(["idle", "idle"]);
  const [claimReadyCount, setClaimReadyCount] = useState(0);
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
  const activeShares = (activeSharesData as bigint | undefined) ?? 0n;
  const burnLabel = burnData !== undefined ? fmt(burnData as bigint, 18, 0) : PARAMS.activationBurn.toLocaleString();
  const activeOwned = brokers.filter((item) => item.active).length;
  const backing = useBrokerBacking(brokers.map((b) => b.id));
  const inactiveOwned = brokers.length - activeOwned;
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
            ? `Not enough $COAT — need ${burnLabel}. Buy some in Swap.`
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
    try {
      const id = BigInt(raw);
      const [active, owner, wallet, basket, claimable] = await Promise.all([
        client.readContract({ address: ADDR.broker, abi: brokerAbi, functionName: "activated", args: [id] }),
        client.readContract({ address: ADDR.broker, abi: brokerAbi, functionName: "ownerOf", args: [id] }),
        client.readContract({ address: ADDR.broker, abi: brokerAbi, functionName: "accountOf", args: [id] }),
        client.readContract({ address: ADDR.strategyRegistry, abi: strategyRegistryAbi, functionName: "getBasket", args: [0n] }),
        client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "claimable", args: [id] }),
      ]);
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
      const nonZero = balances.filter((holding) => holding.bal > 0n);
      setHoldings(nonZero);
      setSelectedStock((current) => nonZero.some((holding) => holding.token === current) ? current : (nonZero[0]?.token ?? ""));
      setPending(claimable[0].map((token, i) => {
        const holding = balances.find((item) => item.token.toLowerCase() === token.toLowerCase());
        return { sym: holding?.sym ?? short(token), bal: claimable[1][i] };
      }).filter((h) => h.bal > 0n));
    } catch {
      if (!silent) {
        act.setStatus("Token not found — is the id right?", "err");
        setInfo(null);
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
      const inactive = brokers.filter((item) => !item.active);
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
        const transfers: { token: Address; amount: bigint }[] = [];
        knownTokens.forEach((token, i) => {
          // Post-claim balance = current wallet balance + what the claim will move in.
          // claimable only grows until claimed, so this amount can never overshoot.
          const total = balances[i] + (claimByToken.get(token.toLowerCase()) ?? 0n);
          if (total > 0n) transfers.push({ token, amount: total });
        });
        const needsClaim = (claim[1] as readonly bigint[]).some((amount) => amount > 0n);
        if (transfers.length > 0 || needsClaim) jobs.push({ id: b.id, wallet: wallet as Address, transfers, needsClaim });
      }
      if (jobs.length === 0) {
        claimTx.setStatus("Nothing to withdraw — your Brokers haven't accrued stock yet.", "ok");
        return;
      }

      const readyIds = jobs.filter((j) => j.needsClaim).map((j) => j.id);
      const claimChunks: bigint[][] = [];
      for (let i = 0; i < readyIds.length; i += 5) claimChunks.push(readyIds.slice(i, i + 5));

      const calls = [
        ...claimChunks.map((ids) => ({
          to: ADDR.booster,
          data: encodeFunctionData({ abi: boosterAbi, functionName: "claimBatch", args: [ids] }),
        })),
        ...jobs.flatMap((j) => j.transfers.map((t) => ({
          to: j.wallet,
          data: encodeFunctionData({
            abi: brokerAccountAbi, functionName: "execute",
            args: [t.token, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [address, t.amount] }), 0],
          }),
        }))),
      ];

      if (calls.length > 1 && (await atomicSupported())) {
        claimTx.setStatus(`Bundling ${calls.length} steps into one confirmation…`);
        const { id } = await sendCalls(wagmiConfig, { calls, chainId: activeChain.id });
        claimTx.setStatus("Waiting for the bundle to confirm…");
        const result = await waitForCallsStatus(wagmiConfig, { id });
        if (result.status !== "success") throw new Error("The batch did not complete — nothing partial was left behind.");
      } else {
        const total = claimChunks.length + jobs.reduce((sum, j) => sum + j.transfers.length, 0);
        let n = 0;
        for (const ids of claimChunks) {
          n += 1;
          claimTx.setStatus(`Tx ${n}/${total} — claiming ${ids.length} Broker${ids.length > 1 ? "s" : ""}…`);
          const h = await writeContractAsync({
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
      }
      claimTx.setStatus(`Done — all stock from ${jobs.length} Broker${jobs.length > 1 ? "s" : ""} is in your wallet.`, "ok");
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
      const batches: bigint[][] = [];
      for (let i = 0; i < ready.length; i += 5) batches.push(ready.slice(i, i + 5));
      if (batches.length > 1 && (await atomicSupported())) {
        claimTx.setStatus(`Bundling ${batches.length} claim batches into one confirmation…`);
        const { id } = await sendCalls(wagmiConfig, {
          calls: batches.map((batch) => ({
            to: ADDR.booster,
            data: encodeFunctionData({ abi: boosterAbi, functionName: "claimBatch", args: [batch] }),
          })),
          chainId: activeChain.id,
        });
        claimTx.setStatus("Waiting for the bundle to confirm…");
        const result = await waitForCallsStatus(wagmiConfig, { id });
        if (result.status !== "success") throw new Error("The batch did not complete.");
      } else {
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

  return (
    <div className="grid gap-5">
      <div className="card">
        <div className="flex items-center justify-between mb-1">
          <h2 className="pixel-title text-[15px]">Your Brokers</h2>
          {address && (
            <button className="text-ink-soft hover:text-accent" onClick={reloadBrokers} aria-label="refresh">
              <Icon name="search" className="w-4 h-4" />
            </button>
          )}
        </div>
        <p className="text-ink-soft text-sm mb-1">Pick one to activate. Green = already earning.</p>
        <p className="text-ink-soft text-sm mb-4">
          {backing.totalUsd !== null && brokers.length > 0
            ? <>Your Brokers are backed by <b className="text-ink-strong">{usd(backing.totalUsd)}</b> of real tokenized stock — the floor under the art.</>
            : "Every active Broker holds real stock in its own wallet."}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-4">
          <Stat k="Owned" v={brokers.length.toString()} />
          <Stat k="Active shares" v={activeOwned.toString()} />
          <Stat k="Claim-ready" v={claimReadyCount.toString()} />
          <Stat k="Activate all" v={activateAllCost !== undefined ? `${fmt(activateAllCost, 18, 0)} COAT` : "—"} />
        </div>
        {!address ? (
          <p className="text-ink-soft text-sm">Connect your wallet to see your Brokers.</p>
        ) : brokersLoading ? (
          <p className="text-ink-soft text-sm">Loading…</p>
        ) : brokers.length === 0 ? (
          <p className="text-ink-soft text-sm">No Brokers yet — mint one first.</p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2.5">
            {brokers.map((b) => (
              <BrokerCard key={b.id.toString()} id={b.id} active={b.active} selected={tokenId === b.id.toString()} onSelect={() => selectBroker(b.id)} backingUsd={backing.byId[b.id.toString()]} />
            ))}
          </div>
        )}
        {address && inactiveOwned > 1 && (
          <button className="btn btn-ghost w-full mt-4" onClick={activateAll} disabled={act.busy}>
            <Icon name="power" /> ACTIVATE ALL INACTIVE ({inactiveOwned})
          </button>
        )}
        {address && claimReadyCount > 0 && (
          <button className="btn btn-accent w-full mt-2" onClick={claimAll} disabled={claimTx.busy}>
            <Icon name="download" /> {claimTx.busy ? "CLAIMING…" : `CLAIM ALL (${claimReadyCount})`}
          </button>
        )}
        {address && brokers.length > 0 && (
          <>
            <button className="btn btn-ghost w-full mt-2" onClick={withdrawAll} disabled={claimTx.busy}>
              <Icon name="wallet" /> {claimTx.busy ? "WORKING…" : "WITHDRAW EVERYTHING TO MY WALLET"}
            </button>
            <p className="text-[11px] text-ink-soft mt-1.5">
              Claims every Broker and moves all stock into your connected wallet. On wallets that
              support batching it&rsquo;s a single confirmation; otherwise the transactions run
              back-to-back with a progress counter.
            </p>
          </>
        )}
      </div>

      <div className="card">
        <h2 className="pixel-title text-[15px] mb-1">Activate &amp; earn</h2>
        <p className="text-ink-soft text-sm mb-5">
          Burn {burnLabel} $COAT to switch a Broker ON. It starts accruing claimable tokenized-stock
          rewards; claim moves them into its wallet. Approve + activate in one click.
        </p>
        <div className="grid grid-cols-3 gap-2.5 mb-4">
          <Stat k="Your $COAT" v={fmt(coatBal as bigint | undefined, 18, 0)} />
          <Stat k="Burn to activate" v={burnLabel} />
          <Stat k="Active Brokers" v={activeShares.toString()} />
        </div>

        <span className="label">Broker token id</span>
        <div className="flex gap-2">
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

        {info && (
          <div className="flex items-center gap-3 mt-3">
            <span className="text-ink-soft text-sm">Status:</span>
            <span className={`badge ${info.active ? "border-good text-good" : "border-ink-soft text-ink-soft"}`}>
              {info.active ? "ACTIVE" : "INACTIVE"}
            </span>
          </div>
        )}

        <button className="btn btn-accent w-full mt-4" onClick={activate} disabled={act.busy || !canActivate}>
          <Icon name="power" /> {act.busy ? "WORKING…" : "APPROVE + ACTIVATE"}
        </button>
        {activateReason && <p className="text-accent text-sm mt-2">{activateReason}</p>}
        <StepFlow steps={[{ label: "approve COAT", state: steps[0] }, { label: "activate", state: steps[1] }]} />
        <StatusLine msg={act.msg} kind={act.kind} />
      </div>

      <div className="card">
        <h2 className="pixel-title text-[15px] mb-1">Your Broker&apos;s wallet</h2>
        <p className="text-ink-soft text-sm mb-4">
          Unclaimed rewards are shown separately below. Claimed stocks live in the self-custodial ERC-6551
          wallet and move with the NFT only while you leave them there.
        </p>
        {!info ? (
          <p className="text-ink-soft text-sm">Enter a token id and press CHECK.</p>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-3">
              <div className="border border-line bg-cream shrink-0">
                <BrokerArtwork tokenId={info.id} size={72} />
              </div>
              <div>
                <div className="font-pixel text-sm text-ink-strong">Broker #{info.id.toString()}</div>
                <div className="flex items-center gap-2 text-sm mt-1">
                  <span className="text-ink-soft">wallet:</span>
                  <code className="font-pixel text-[11px]">{short(info.wallet)}</code>
                </div>
              </div>
            </div>
            {holdings.length ? (
              <div className="grid gap-1.5 mt-3">
                {holdings.map((h) => (
                  <div key={h.token} className="flex items-center gap-3">
                    <span className="badge">{h.sym}</span>
                    <span className="font-pixel text-sm">{fmt(h.bal, h.decimals, 7)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-ink-soft text-sm mt-3">No claimed stock in this wallet yet.</p>
            )}
            {pending.length > 0 && (
              <div className="mt-4 border-t border-line pt-3">
                <div className="label">Accruing — auto-claimed to this wallet hourly</div>
                {pending.map((h) => <div key={h.sym} className="text-sm">{h.sym}: {fmt(h.bal, 18, 4)}</div>)}
              </div>
            )}
          </>
        )}
        <button className="btn btn-accent w-full mt-4" onClick={claimOnly} disabled={!isOwner || !hasClaimable || claimTx.busy}>
          <Icon name="download" /> {claimTx.busy ? "CLAIMING…" : "CLAIM → BROKER WALLET"}
        </button>
        {info && isOwner && holdings.length > 0 && (
          <button className="btn btn-ghost w-full mt-2" onClick={withdraw} disabled={claimTx.busy}>
            {claimTx.busy ? "WITHDRAWING…" : "Withdraw to my wallet (optional)"}
          </button>
        )}
        {info && isOwner && (
          <p className="text-ink-soft text-sm mt-2">
            Earned stock is claimed into your Broker&apos;s wallet automatically about once an hour, and one Claim
            settles anything still pending in a single transaction. It lives in your Broker&apos;s self-custodial
            wallet and moves with the NFT — no further step needed. Optionally, &quot;Withdraw&quot; moves it out to your
            connected wallet (one transfer per token).
            {!hasClaimable && !holdings.length && " Nothing to claim yet."}
          </p>
        )}
        <StatusLine msg={claimTx.msg} kind={claimTx.kind} />

        {info && isOwner && (
          <div className="mt-5 border-t border-line pt-4">
            <span className="label">Transfer accumulated stocks</span>
            <p className="text-ink-soft text-sm mb-2">
              Sends stock out of this Broker&apos;s wallet. The Broker NFT stays with you and remains active.
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
            <StatusLine msg={xfer.msg} kind={xfer.kind} />
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <div className="text-[11px] text-ink-soft uppercase tracking-widest">{k}</div>
      <div className="font-pixel text-lg text-ink-strong mt-1">{v}</div>
    </div>
  );
}
