"use client";

// A react-query wrapper that survives full page reloads by persisting the last result in
// localStorage. On refresh it hydrates instantly from storage with NO network call while the
// data is still fresh (staleTime), and only revalidates in the background once stale —
// updating the view solely if the payload actually changed. Purpose: stop spending an API
// call (or an RPC round) on every hard refresh, yet still pick up real updates automatically.
//
// Safe to read storage during render: the callers are tab components that only ever mount on
// the client (SSR renders the Home tab), so there is no server/client hydration mismatch.

import { useQuery } from "@tanstack/react-query";

type Stored<T> = { data: T; ts: number };

function readCache<T>(key: string): Stored<T> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored<T>;
    if (parsed && "data" in parsed && typeof parsed.ts === "number") return parsed;
  } catch {
    /* corrupt entry — fall through and refetch */
  }
  return null;
}

function writeCache<T>(key: string, data: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    /* quota or serialization failure — caching is best-effort */
  }
}

export function useStoredQuery<T>(opts: {
  storageKey: string;
  queryKey: unknown[];
  queryFn: () => Promise<T>;
  /** How long a stored result is treated as fresh (no refetch on reload). Default 1h. */
  staleTime?: number;
}) {
  const cached = readCache<T>(opts.storageKey);
  return useQuery<T>({
    queryKey: opts.queryKey,
    queryFn: async () => {
      const data = await opts.queryFn();
      writeCache(opts.storageKey, data);
      return data;
    },
    staleTime: opts.staleTime ?? 60 * 60_000,
    // Seed from storage so a reload renders immediately; the stored timestamp lets
    // react-query decide staleness, and structural sharing means an unchanged refetch
    // never triggers a re-render.
    initialData: cached?.data,
    initialDataUpdatedAt: cached?.ts,
  });
}
