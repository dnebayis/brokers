"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { encodeFunctionData, isAddress, type Address } from "viem";
import { activeChain } from "@/lib/chains";
import { ADDR } from "@/lib/config";
import { boosterAbi, brokerAccountAbi } from "@/lib/abis";
import { FLOOR, erc20MiniAbi, basketRouterAbi } from "@/lib/floor";
import { PLAYBOOKS, playbooksReady, playbookEngineAbi, PB_MODE } from "@/lib/playbooks";
import { client, waitForSuccessfulReceipt } from "@/lib/client";
import { useTx } from "@/lib/useTx";
import { Icon } from "@/components/ui/Icon";
import { StatusLine } from "@/components/ui/Status";

// Human plans, not contract enums. Claiming is NOT offered as a plan of its own: a
// playbook claims as its first step anyway, the app has a permissionless one-click claim,
// and the weekly ClaimSweeper pass claims for everyone regardless, so selling it as a
// feature would be dishonest. What needs a decision is where the stock goes after that.
type Plan = "sweep" | "usdg" | "coat";
const PLAN_LABEL: Record<Plan, string> = {
  sweep: "Send me the stocks",
  usdg: "Convert to USDG and send",
  coat: "Convert to $COAT and send",
};
const PLAN_SUB: Record<Plan, string> = {
  sweep: "the basket stocks your Broker earns, moved to your address",
  usdg: "sold through The Floor, stablecoin delivered to your address",
  coat: "sold through The Floor, then bought back as $COAT through the hooked pool",
};
// Mirrors the keeper's PLAYBOOKS_MIN_USDG: under this an order waits, because moving it
// would cost more gas than the earnings being moved.
const RUN_AT = 5;

const PLAN_MODE: Record<Plan, number> = {
  sweep: PB_MODE.SWEEP,
  usdg: PB_MODE.TO_USDG,
  coat: PB_MODE.TO_COAT,
};

type Installed = { autoClaim: boolean; mode: number; dest: Address; paused: boolean; setter: Address };

function planOf(p: Installed): string {
  if (p.paused) return "paused";
  if (p.mode === PB_MODE.TO_USDG) return "USDG → your address";
  if (p.mode === PB_MODE.TO_COAT) return "$COAT → your address";
  if (p.mode === PB_MODE.SWEEP) return "stocks → your address";
  return "off";
}

/** One playbook control surface for every owned Broker: pick a plan once, apply it to one
 *  or all. Plans that move stock out of the Broker wallet need its one-time per-stock
 *  approval, surfaced as an explicit checklist — never a hidden signature.
 *  The $COAT exit crosses the hooked pool, which has no Chainlink floor of its own, so the
 *  keeper prices that order and passes a minimum-out before running it. */
export function PlaybookPanel({
  brokers,
  walletsById,
}: {
  brokers: { id: bigint; active: boolean | null }[];
  walletsById: Record<string, Address | undefined>;
}) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const tx = useTx();

  const engine = PLAYBOOKS.engine as Address;
  const [plan, setPlan] = useState<Plan>("sweep");
  const [destKind, setDestKind] = useState<"broker" | "me" | "custom">("me");
  const [customDest, setCustomDest] = useState("");
  const [installed, setInstalled] = useState<Record<string, Installed>>({});
  const [stocks, setStocks] = useState<Address[]>([]);
  const [allowed, setAllowed] = useState<Record<string, boolean>>({}); // `${tba}|${stock}`
  const [worth, setWorth] = useState<Record<string, number>>({}); // tokenId -> USD in its wallet
  const [reloadKey, setReloadKey] = useState(0);

  // Both plans move stock out of the Broker wallet, so both need its one-time allowance.
  const needsApproval = true;

  // Installed playbooks + the Booster's stock list (the set conversions must be approved for).
  useEffect(() => {
    if (!playbooksReady || brokers.length === 0) return;
    let stale = false;
    (async () => {
      try {
        const [pbs, count] = await Promise.all([
          Promise.all(
            brokers.map((b) =>
              Promise.all([
                client.readContract({ address: engine, abi: playbookEngineAbi, functionName: "playbookOf", args: [b.id] }),
                client.readContract({ address: engine, abi: playbookEngineAbi, functionName: "setterOf", args: [b.id] }),
              ]),
            ),
          ),
          client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "knownTokenCount" }),
        ]);
        const toks = (await Promise.all(
          Array.from({ length: Number(count) }, (_, i) =>
            client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "knownTokens", args: [BigInt(i)] }),
          ),
        )) as Address[];
        if (stale) return;
        const map: Record<string, Installed> = {};
        brokers.forEach((b, i) => {
          const [pb, setter] = pbs[i] as [readonly [boolean, number, Address, boolean], Address];
          map[b.id.toString()] = { autoClaim: pb[0], mode: Number(pb[1]), dest: pb[2], paused: pb[3], setter };
        });
        setInstalled(map);
        setStocks(toks);

        // What each Broker's wallet is worth, valued exactly the way the keeper values it
        // (the Floor's Chainlink floor). An order waits until this clears the threshold, so
        // showing it turns "nothing happened" into a number the owner can watch.
        const worths: Record<string, number> = {};
        for (const b of brokers) {
          const w = walletsById[b.id.toString()];
          if (!w) continue;
          let usd = 0;
          for (const t of toks) {
            try {
              const bal = (await client.readContract({
                address: t, abi: erc20MiniAbi, functionName: "balanceOf", args: [w],
              })) as bigint;
              if (bal === 0n) continue;
              const floorOut = (await client.readContract({
                address: FLOOR.router as Address, abi: basketRouterAbi,
                functionName: "minUsdgOut", args: [t, bal],
              })) as bigint;
              usd += Number(floorOut) / 10 ** FLOOR.usdgDecimals;
            } catch {
              /* one unreadable leg should not blank the whole row */
            }
          }
          worths[b.id.toString()] = usd;
        }
        if (!stale) setWorth(worths);
      } catch {
        /* panel stays read-only-empty on RPC hiccups */
      }
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokers, reloadKey]);

  // Allowance checklist, only when a convert plan is selected.
  useEffect(() => {
    if (!needsApproval || stocks.length === 0) return;
    let stale = false;
    (async () => {
      const entries: Record<string, boolean> = {};
      for (const b of brokers) {
        const tba = walletsById[b.id.toString()];
        if (!tba) continue;
        const res = await Promise.all(
          stocks.map((s) =>
            client
              .readContract({ address: s, abi: erc20MiniAbi, functionName: "allowance", args: [tba, engine] })
              .catch(() => 0n),
          ),
        );
        stocks.forEach((s, i) => {
          entries[`${tba}|${s}`] = (res[i] as bigint) > 2n ** 200n; // effectively-max check
        });
      }
      if (!stale) setAllowed(entries);
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsApproval, stocks, brokers, reloadKey]);

  const dest = (): Address => {
    if (destKind === "broker" && plan === "usdg") return "0x0000000000000000000000000000000000000000";
    if (destKind === "broker") return address!; // sweeping to itself is a no-op — use the owner
    if (destKind === "me") return address!;
    return customDest as Address;
  };

  const destInvalid = destKind === "custom" && !isAddress(customDest);

  const missingApprovals = useMemo(() => {
    if (!needsApproval) return [];
    const out: { id: bigint; tba: Address; stock: Address }[] = [];
    for (const b of brokers) {
      const tba = walletsById[b.id.toString()];
      if (!tba) continue;
      for (const s of stocks) if (!allowed[`${tba}|${s}`]) out.push({ id: b.id, tba, stock: s });
    }
    return out;
  }, [needsApproval, brokers, walletsById, stocks, allowed]);

  async function approveOne(tba: Address, stock: Address) {
    const data = encodeFunctionData({
      abi: erc20MiniAbi,
      functionName: "approve",
      args: [engine, 2n ** 256n - 1n],
    });
    const h = await writeContractAsync({
      address: tba,
      abi: brokerAccountAbi,
      functionName: "execute",
      args: [stock, 0n, data, 0],
      chainId: activeChain.id,
    });
    await waitForSuccessfulReceipt(h);
  }

  const applyTo = (ids: bigint[]) =>
    tx.run(async () => {
      if (destInvalid) throw new Error("Enter a valid destination address.");
      // approvals first, so a saved playbook is never silently inert
      if (needsApproval) {
        const todo = missingApprovals.filter((m) => ids.some((id) => id === m.id));
        for (let i = 0; i < todo.length; i++) {
          tx.setStatus(`Broker wallet approval ${i + 1}/${todo.length} — one time only…`);
          await approveOne(todo[i].tba, todo[i].stock);
        }
      }
      for (let i = 0; i < ids.length; i++) {
        tx.setStatus(`Saving playbook for Broker #${ids[i]} (${i + 1}/${ids.length})…`);
        const h = await writeContractAsync({
          address: engine,
          abi: playbookEngineAbi,
          functionName: "setPlaybook",
          args: [ids[i], true, PLAN_MODE[plan], dest()],
          chainId: activeChain.id,
        });
        await waitForSuccessfulReceipt(h);
      }
      tx.setStatus("Playbook saved — the engine takes it from here.", "ok");
      setReloadKey((k) => k + 1);
    });

  const turnOff = (id: bigint) =>
    tx.run(async () => {
      tx.setStatus(`Turning Broker #${id}'s playbook off…`);
      const h = await writeContractAsync({
        address: engine,
        abi: playbookEngineAbi,
        functionName: "clearPlaybook",
        args: [id],
        chainId: activeChain.id,
      });
      await waitForSuccessfulReceipt(h);
      tx.setStatus("Playbook removed.", "ok");
      setReloadKey((k) => k + 1);
    });

  if (!playbooksReady || !address || brokers.length === 0) return null;
  const activeBrokers = brokers.filter((b) => b.active === true);

  return (
    <div className="card">
      <h2 className="pixel-title text-[15px] mb-1">Playbooks</h2>
      <p className="text-ink-soft text-sm mb-4">
        Your Broker earns every time the engine buys, and that salary lands as stock in the
        Broker&rsquo;s own wallet. Getting it out from there means claiming, then signing once
        per stock. A playbook automates the whole thing: say where the earnings should go and
        the engine claims and delivers them for you. Free, non-custodial, revocable, and
        switched off the moment you sell the Broker. An order runs once the Broker&rsquo;s
        wallet is worth about $5, so the gas never costs more than the salary it is moving,
        and nothing is lost while it waits: unclaimed earnings sit in the Booster in your
        Broker&rsquo;s name and you can always claim them yourself in one click.
      </p>

      {/* the plan */}
      <span className="label">The plan</span>
      <div className="grid gap-1.5 mt-1 mb-3">
        {(Object.keys(PLAN_LABEL) as Plan[]).map((p) => (
          <label key={p} className="flex items-start gap-2 text-sm cursor-pointer select-none">
            <input
              type="radio"
              name="pb-plan"
              checked={plan === p}
              onChange={() => setPlan(p)}
              className="accent-[var(--c-accent)] mt-1"
            />
            <span>
              {PLAN_LABEL[p]}
              <span className="block text-ink-soft text-[12px]">{PLAN_SUB[p]}</span>
            </span>
          </label>
        ))}
      </div>

      {/* where proceeds land */}
      {needsApproval && (
        <>
          <span className="label">Deliver to</span>
          <div className="flex flex-wrap items-center gap-3 mt-1 mb-3 text-sm">
            {(
              // Sweeping to the Broker's own wallet would be a no-op (the stock is already
              // there), so that destination is only offered for the USDG plan, where it
              // means "turn the holdings into stablecoin but leave them inside the NFT".
              (plan !== "sweep"
                ? ([
                    ["me", "my connected wallet"],
                    ["broker", "keep it in the Broker's wallet"],
                    ["custom", "another address"],
                  ] as const)
                : ([
                    ["me", "my connected wallet"],
                    ["custom", "another address"],
                  ] as const)) as readonly (readonly ["broker" | "me" | "custom", string])[]
            ).map(([k, label]) => (
              <label key={k} className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="radio"
                  name="pb-dest"
                  checked={destKind === k}
                  onChange={() => setDestKind(k)}
                  className="accent-[var(--c-accent)]"
                />
                {label}
              </label>
            ))}
          </div>
          {destKind === "custom" && (
            <input
              className="fld w-full mb-3"
              placeholder="0x…"
              value={customDest}
              onChange={(e) => setCustomDest(e.target.value)}
            />
          )}
          {missingApprovals.length > 0 && (
            <p className="text-[12px] text-ink-soft mb-3">
              Moving stock out of the Broker wallet needs {missingApprovals.length} one-time approval
              {missingApprovals.length > 1 ? "s" : ""} (one per stock, never again) — they run
              automatically before the playbook is saved.
            </p>
          )}
        </>
      )}

      {/* per-broker rows */}
      <div className="grid gap-1.5 mb-3">
        {activeBrokers.map((b) => {
          const key = b.id.toString();
          const pb = installed[key];
          const live = pb && pb.setter.toLowerCase() === address.toLowerCase() && planOf(pb) !== "off";
          return (
            <div key={key} className="flex items-center justify-between border border-line px-3 py-2 text-sm">
              <span>
                <b className="text-ink-strong">#{key}</b>{" "}
                <span className={live ? "text-good" : "text-ink-soft"}>{pb ? planOf(pb) : "…"}</span>
                {live && worth[key] !== undefined && (
                  <span className="block text-[11px] text-ink-soft">
                    {worth[key] >= RUN_AT
                      ? `$${worth[key].toFixed(2)} in its wallet, runs on the next keeper pass`
                      : `$${worth[key].toFixed(2)} of $${RUN_AT} - the engine moves it once it gets there`}
                  </span>
                )}
              </span>
              <span className="flex gap-2">
                <button className="btn btn-ghost !py-1 !px-2 text-[10px]" onClick={() => applyTo([b.id])} disabled={tx.busy}>
                  Apply
                </button>
                {live && (
                  <button className="btn btn-ghost !py-1 !px-2 text-[10px]" onClick={() => turnOff(b.id)} disabled={tx.busy}>
                    Off
                  </button>
                )}
              </span>
            </div>
          );
        })}
        {activeBrokers.length === 0 && (
          <p className="text-ink-soft text-sm">Playbooks run on active Brokers — activate one first.</p>
        )}
      </div>

      {activeBrokers.length > 1 && (
        <button className="btn btn-accent w-full" onClick={() => applyTo(activeBrokers.map((b) => b.id))} disabled={tx.busy}>
          <Icon name="power" /> APPLY TO ALL ACTIVE ({activeBrokers.length})
        </button>
      )}
      <StatusLine msg={tx.msg} kind={tx.kind} />
    </div>
  );
}
