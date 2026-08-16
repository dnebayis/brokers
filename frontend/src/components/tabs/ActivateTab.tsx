"use client";

import { useEffect, useState } from "react";
import { encodeFunctionData, formatUnits, isAddress, parseUnits, type Address } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { ADDR, PARAMS } from "@/lib/config";
import { brokerAbi, brokerAccountAbi, coatAbi, boosterAbi, erc20Abi, strategyRegistryAbi } from "@/lib/abis";
import { activeChain } from "@/lib/chains";
import { useTx } from "@/lib/useTx";
import { client, waitForSuccessfulReceipt } from "@/lib/client";
import { useOwnedBrokers } from "@/lib/useOwnedBrokers";
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
      const tokens = basket[0];
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

  const claim = () =>
    claimTx.run(async () => {
      if (!info) throw new Error("Check a Broker first.");
      claimTx.setStatus("Confirm claim…");
      const h = await writeContractAsync({
        address: ADDR.booster, abi: boosterAbi, functionName: "claim", args: [info.id], chainId: activeChain.id,
      });
      await waitForSuccessfulReceipt(h);
      claimTx.setStatus("Claimed — stock moved into the Broker's wallet.", "ok");
      refetch();
      reloadBrokers();
      check();
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
        <p className="text-ink-soft text-sm mb-4">Pick one to activate. Green = already earning.</p>
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
              <BrokerCard key={b.id.toString()} id={b.id} active={b.active} selected={tokenId === b.id.toString()} onSelect={() => selectBroker(b.id)} />
            ))}
          </div>
        )}
        {address && inactiveOwned > 1 && (
          <button className="btn btn-ghost w-full mt-4" onClick={activateAll} disabled={act.busy}>
            <Icon name="power" /> ACTIVATE ALL INACTIVE ({inactiveOwned})
          </button>
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
                <div className="label">Ready to claim</div>
                {pending.map((h) => <div key={h.sym} className="text-sm">{h.sym}: {fmt(h.bal, 18, 4)}</div>)}
              </div>
            )}
          </>
        )}
        <button className="btn btn-ghost w-full mt-4" onClick={claim} disabled={!isOwner || !(info?.active || hasClaimable) || claimTx.busy}>
          <Icon name="download" /> {claimTx.busy ? "CLAIMING…" : "CLAIM NOW → WALLET"}
        </button>
        {info && isOwner && (
          <p className="text-ink-soft text-sm mt-2">
            Rewards are distributed to your Broker&apos;s wallet automatically about once an hour — you can claim now
            instead of waiting.
            {!hasClaimable && (holdings.length ? " Everything accrued is already in this wallet." : " Nothing is pending right now.")}
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
