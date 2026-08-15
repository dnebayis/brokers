"use client";

import { useState } from "react";
import { useAccount, useBalance, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { formatEther, parseEventLogs } from "viem";
import { ADDR, PARAMS } from "@/lib/config";
import { brokerAbi } from "@/lib/abis";
import { activeChain } from "@/lib/chains";
import { useTx } from "@/lib/useTx";
import { client, waitForSuccessfulReceipt } from "@/lib/client";
import { BrokerAvatar } from "@/lib/brokerArt";
import { Icon } from "@/components/ui/Icon";
import { StatusLine } from "@/components/ui/Status";

export function MintTab() {
  const { address } = useAccount();
  
  const { writeContractAsync } = useWriteContract();
  const { run, busy, msg, kind, setStatus } = useTx();
  const [qty, setQty] = useState(1);
  const [mintedIds, setMintedIds] = useState<bigint[]>([]);
  const { data: ethBal } = useBalance({ address, chainId: activeChain.id });

  const { data: supply, refetch: refetchSupply } = useReadContracts({
    contracts: [
      { address: ADDR.broker, abi: brokerAbi, functionName: "totalMinted" },
      { address: ADDR.broker, abi: brokerAbi, functionName: "MAX_SUPPLY" },
      { address: ADDR.broker, abi: brokerAbi, functionName: "mintPriceWei" },
      { address: ADDR.broker, abi: brokerAbi, functionName: "mintOpen" },
    ],
  });
  const { data: owned, refetch: refetchOwned } = useReadContract({
    address: ADDR.broker, abi: brokerAbi, functionName: "balanceOf",
    args: address ? [address] : undefined, query: { enabled: !!address },
  });
  const { data: mintedBy, refetch: refetchMintedBy } = useReadContract({
    address: ADDR.broker, abi: brokerAbi, functionName: "mintedBy",
    args: address ? [address] : undefined, query: { enabled: !!address },
  });
  const refetch = () => { refetchSupply(); refetchOwned(); refetchMintedBy(); };

  const minted = (supply?.[0]?.result as bigint) ?? 0n;
  const max = (supply?.[1]?.result as bigint) ?? BigInt(PARAMS.maxSupply);
  const priceWei = supply?.[2]?.result as bigint | undefined; // on-chain source of truth
  const mintOpen = (supply?.[3]?.result as boolean | undefined) ?? false;
  const priceEth = priceWei !== undefined ? formatEther(priceWei) : PARAMS.mintPriceEth;
  const pct = max > 0n ? Number((minted * 1000n) / max) / 10 : 0;
  const totalCost = priceWei !== undefined ? priceWei * BigInt(qty) : undefined;
  const total = totalCost !== undefined ? formatEther(totalCost) : "—";

  // pre-flight: don't let the user submit a tx that will revert (and waste gas)
  const soldOut = minted >= max;
  const overCap = mintedBy !== undefined && Number(mintedBy) + qty > PARAMS.walletCap;
  const insufficient = !!(address && ethBal && totalCost !== undefined && ethBal.value < totalCost);
  const reason = !address
    ? "Connect your wallet to mint."
    : !mintOpen
      ? "Mint is currently closed."
      : soldOut
      ? "Sold out."
      : overCap
        ? `Wallet cap is ${PARAMS.walletCap} — lower the quantity.`
        : insufficient
          ? `Not enough ETH — need ${total} + gas.`
          : "";
  const canMint = address && !reason && priceWei !== undefined;

  const clamp = (n: number) => setQty(Math.max(1, Math.min(PARAMS.walletCap, n)));

  const mint = () =>
    run(async () => {
      // read the price fresh on-chain (source of truth) so value always matches the contract
      const price = (await client.readContract({
        address: ADDR.broker, abi: brokerAbi, functionName: "mintPriceWei",
      })) as bigint;
      setStatus(`Confirm in wallet: mint ${qty} for ${formatEther(price * BigInt(qty))} ETH…`);
      const hash = await writeContractAsync({
        address: ADDR.broker,
        abi: brokerAbi,
        functionName: "mint",
        args: [BigInt(qty)],
        value: price * BigInt(qty),
        chainId: activeChain.id,
      });
      setStatus("Minting… waiting for confirmation.");
      const receipt = await waitForSuccessfulReceipt(hash);
      const ids = parseEventLogs({ abi: brokerAbi, logs: receipt.logs, eventName: "Minted", strict: true })
        .map((log) => log.args.tokenId);
      if (ids.length !== qty) throw new Error("Mint confirmation did not contain every Minted event.");
      setMintedIds(ids);
      setStatus(`Minted ${qty} Broker(s) — inactive until you activate.`, "ok");
      refetch();
    });

  return (
    <div className="card">
      <h2 className="pixel-title text-[15px] mb-1">Mint a Broker</h2>
      <p className="text-ink-soft text-sm mb-5">
        Flat {priceEth} ETH. Each mint draws a unique pseudo-random ID from the remaining
        collection and creates its own on-chain wallet. Brokers arrive inactive.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-4">
        <Stat k="Minted" v={`${minted} / ${max}`} />
        <Stat k="Price" v={`${priceEth}Ξ`} />
        <Stat k="Your Brokers" v={owned !== undefined ? owned.toString() : "—"} />
          <Stat k="Primary mint cap" v={mintedBy !== undefined ? `${mintedBy} / ${PARAMS.walletCap}` : `— / ${PARAMS.walletCap}`} />
      </div>

      <div className="h-3.5 bg-cream-3 border border-ink mb-4" aria-hidden>
        <span className="block h-full bg-ink" style={{ width: `${pct}%` }} />
      </div>

      <span className="label">Quantity</span>
      <div className="flex items-center justify-between border-2 border-ink bg-cream p-1.5">
        <button className="btn btn-ghost w-10 h-9 shadow-pixel-sm" onClick={() => clamp(qty - 1)} aria-label="minus">
          <Icon name="minus" />
        </button>
        <span className="font-pixel text-xl text-ink-strong">{qty}</span>
        <button className="btn btn-ghost w-10 h-9 shadow-pixel-sm" onClick={() => clamp(qty + 1)} aria-label="plus">
          <Icon name="plus" />
        </button>
      </div>
      <p className="text-ink-soft text-sm mt-2">Total: {total === "—" ? "—" : `${total} ETH`}</p>

      <button className="btn btn-accent w-full mt-4" onClick={mint} disabled={busy || !canMint}>
        <Icon name="stamp" /> {busy ? "MINTING…" : "MINT"}
      </button>
      {reason && <p className="text-accent text-sm mt-2">{reason}</p>}
      <StatusLine msg={msg} kind={kind} />

      {mintedIds.length > 0 && (
        <div className="mt-6 border-t border-line pt-4">
          <div className="font-pixel text-[12px] text-ink-strong mb-2">Your fresh Broker{mintedIds.length > 1 ? "s" : ""}</div>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2.5">
            {mintedIds.map((id) => (
              <div key={id.toString()} className="border border-line bg-cream p-1">
                <BrokerAvatar tokenId={id} size={96} />
                <div className="font-pixel text-[10px] text-ink-strong text-center mt-1">#{id.toString()}</div>
              </div>
            ))}
          </div>
          <p className="text-ink-soft text-sm mt-2">Head to <b>Activate</b> to switch them on.</p>
        </div>
      )}
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
