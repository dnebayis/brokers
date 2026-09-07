import { NextResponse } from "next/server";
import { CAMPAIGN } from "@/lib/campaign";

// The partner's public campaign feed, proxied. Their terms: poll from our server no more
// than once a minute and serve that to visitors; on 429 or 503 keep the last snapshot and
// never replace totals with zero because one refresh failed. So: one origin fetch per
// minute (Next's data cache), the last good snapshot kept in memory as the fallback, and a
// compact shape for the page (token amounts arrive as 18-decimal base-unit strings and are
// turned into whole-token numbers here, with BigInt, never Number on the raw string).
export const revalidate = 60;

type RawSeat = {
  geezTokenId: string; brokerTokenId: string; brokerAccount: string | null; state: string;
  activationRequested: boolean; brokerActivated: boolean; sponsoredPnutzPurchased: boolean;
  sponsoredStockStatus: string; activatedAt: string | null;
};

export type FeedSeat = {
  geez: string; broker: number; account: string | null; state: string;
  brokerActivated: boolean; pnutzPurchased: boolean; stock: string; activatedAt: string | null;
};
export type FeedPayload = {
  ok: boolean;
  generatedAt: string;
  stale?: boolean;
  campaign: {
    name: string; status: string; startsAt: string; activationClosesAt: string; endsAt: string;
    claimOpensAt: string; claimDeadlineAt: string;
  };
  chains: {
    apechain: { chainId: number; treasuryWallet: string; pnutz: string; geez: string; feeRecipient: string };
    robinhood: { chainId: number; treasuryWallet: string };
  };
  economics: {
    entryFeePnutz: number; stakingFeePct: number; sponsoredPnutzUsd: number; sponsoredStockUsd: number;
    maxPerWallet: number; maxPerTx: number;
  };
  inventory: { total: number; available: number; temporarilyBooked: number; activated: number; disabled: number };
  counts: {
    participantWallets: number; paidReservations: number; paidSeats: number; activationRequested: number;
    geezActivated: number; waitingForPoke: number; stockBatchAssigned: number; stockPurchasing: number;
    stocksPurchased: number; stockAttentionRequired: number;
  };
  purchases: {
    entryFeesPnutz: number; stakingAllocationPnutz: number; coatPurchased: number; coatBurned: number;
    pnutzPurchased: number; pnutzPurchasedPositions: number; sponsoredStockTargetUsd: number;
    sponsoredStockPositions: number; sponsoredStockAllocations: number;
  };
  seats: FeedSeat[];
};

const WEI = 10n ** 18n;
/** Whole tokens from an 18-decimal base-unit string, to two decimals, without going through Number on the raw string. */
const tokens = (units: unknown): number => {
  try {
    const u = BigInt(String(units ?? "0"));
    return Number((u * 100n) / WEI) / 100;
  } catch { return 0; }
};
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function compact(j: Record<string, unknown>): FeedPayload {
  const c = (j.campaign ?? {}) as Record<string, string>;
  const ch = (j.chains ?? {}) as { apechain?: Record<string, unknown>; robinhood?: Record<string, unknown> };
  const ape = (ch.apechain ?? {}) as { chainId?: number; treasuryWallet?: string; contracts?: Record<string, string> };
  const rh = (ch.robinhood ?? {}) as { chainId?: number; treasuryWallet?: string };
  const e = (j.economics ?? {}) as Record<string, unknown>;
  const inv = (j.inventory ?? {}) as Record<string, unknown>;
  const co = (j.counts ?? {}) as Record<string, unknown>;
  const p = (j.purchases ?? {}) as Record<string, unknown>;
  const seats: FeedSeat[] = ((j.seats ?? []) as RawSeat[])
    .map((s) => ({
      geez: String(s.geezTokenId), broker: Number(s.brokerTokenId), account: s.brokerAccount ?? null, state: String(s.state ?? ""),
      brokerActivated: Boolean(s.brokerActivated), pnutzPurchased: Boolean(s.sponsoredPnutzPurchased),
      stock: String(s.sponsoredStockStatus ?? "not_started"), activatedAt: s.activatedAt ?? null,
    }))
    .filter((s) => Number.isInteger(s.broker) && s.broker > 0)
    .sort((a, b) => a.broker - b.broker);
  return {
    ok: true,
    generatedAt: String(j.generatedAt ?? ""),
    campaign: {
      name: c.name ?? "", status: c.status ?? "", startsAt: c.startsAt ?? "", activationClosesAt: c.activationClosesAt ?? "",
      endsAt: c.endsAt ?? "", claimOpensAt: c.claimOpensAt ?? "", claimDeadlineAt: c.claimDeadlineAt ?? "",
    },
    chains: {
      apechain: {
        chainId: n(ape.chainId), treasuryWallet: String(ape.treasuryWallet ?? ""),
        pnutz: String(ape.contracts?.pnutz ?? ""), geez: String(ape.contracts?.geez ?? ""), feeRecipient: String(ape.contracts?.feeRecipient ?? ""),
      },
      robinhood: { chainId: n(rh.chainId), treasuryWallet: String(rh.treasuryWallet ?? "") },
    },
    economics: {
      entryFeePnutz: tokens(e.entryFeePnutzUnits), stakingFeePct: n(e.stakingFeeBps) / 100,
      sponsoredPnutzUsd: n(e.sponsoredPnutzTargetUsd), sponsoredStockUsd: n(e.sponsoredStockTargetUsdPerSeat),
      maxPerWallet: n(e.maxActivationsPerWallet), maxPerTx: n(e.maxActivationsPerTransaction),
    },
    inventory: {
      total: n(inv.total), available: n(inv.available), temporarilyBooked: n(inv.temporarilyBooked),
      activated: n(inv.activated), disabled: n(inv.disabled),
    },
    counts: {
      participantWallets: n(co.participantWallets), paidReservations: n(co.paidReservations), paidSeats: n(co.paidSeats),
      activationRequested: n(co.activationRequested), geezActivated: n(co.geezActivated), waitingForPoke: n(co.waitingForPoke),
      stockBatchAssigned: n(co.stockBatchAssigned), stockPurchasing: n(co.stockPurchasing), stocksPurchased: n(co.stocksPurchased),
      stockAttentionRequired: n(co.stockAttentionRequired),
    },
    purchases: {
      entryFeesPnutz: tokens(p.entryFeesPnutzUnits), stakingAllocationPnutz: tokens(p.stakingAllocationPnutzUnits),
      coatPurchased: tokens(p.coatPurchasedUnits), coatBurned: tokens(p.coatBurnedUnits),
      pnutzPurchased: tokens(p.pnutzPurchasedUnits), pnutzPurchasedPositions: n(p.pnutzPurchasedPositions),
      sponsoredStockTargetUsd: n(p.sponsoredStockTargetUsd), sponsoredStockPositions: n(p.sponsoredStockPositions),
      sponsoredStockAllocations: n(p.sponsoredStockAllocations),
    },
    seats,
  };
}

// The last snapshot that parsed, per process. Their feed asks that a failed refresh never
// blanks the totals; this is how the page keeps showing the desk through a 429 or a 503.
let lastGood: FeedPayload | null = null;

export async function GET() {
  if (!CAMPAIGN.feedUrl) return NextResponse.json({ ok: false, error: "no campaign feed configured" }, { status: 404 });
  try {
    const res = await fetch(CAMPAIGN.feedUrl, {
      next: { revalidate },
      headers: { Accept: "application/json", "User-Agent": "coattail-site/1.0 (+https://www.coattail.cash)" },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const payload = compact((await res.json()) as Record<string, unknown>);
    if (payload.seats.length === 0 && lastGood && lastGood.seats.length > 0) throw new Error("upstream answered with no seats");
    lastGood = payload;
    return NextResponse.json(payload, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch (err) {
    console.warn("campaign feed: upstream failed:", String(err));
    if (lastGood) return NextResponse.json({ ...lastGood, stale: true }, { headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ ok: false, error: "campaign feed unavailable" }, { status: 502 });
  }
}
