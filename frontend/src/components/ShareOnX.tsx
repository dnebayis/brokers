"use client";

import { useEffect, useState } from "react";
import { renderShareCard, shareText, type CardData } from "@/lib/shareCard";

// "Share on X" for one Broker: draws the earnings card in the browser, hands the PNG to the
// visitor (download, or the device share sheet where it can attach files), and opens a
// pre-written post. X's web intent cannot carry an image, so on desktop the card is
// downloaded first and attached by the visitor.
export function ShareOnX({ data }: { data: CardData }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const text = shareText(data);
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
  const fileName = `coattail-broker-${data.id}.png`;

  // a fresh Broker or fresh numbers invalidate the drawn card
  const key = `${data.id}:${data.active}:${data.earnedUsd ?? ""}:${data.backingUsd ?? ""}:${data.coatInside ?? ""}`;
  useEffect(() => {
    setBlob(null);
    setUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setErr("");
  }, [key]);

  async function make(): Promise<Blob | null> {
    setBusy(true);
    setErr("");
    try {
      const b = await renderShareCard(data);
      setBlob(b);
      setUrl(URL.createObjectURL(b));
      return b;
    } catch {
      setErr("Could not draw the card. Try again in a moment.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  const canShareFiles = () => {
    if (typeof navigator === "undefined" || !navigator.canShare) return false;
    try {
      return navigator.canShare({ files: [new File([new Blob()], fileName, { type: "image/png" })] });
    } catch {
      return false;
    }
  };

  async function shareSheet() {
    const b = blob ?? (await make());
    if (!b) return;
    try {
      await navigator.share({ files: [new File([b], fileName, { type: "image/png" })], text });
    } catch {
      /* dismissed */
    }
  }

  return (
    <div className="mt-3 border-t border-line pt-3">
      {!url ? (
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-ghost text-[11px] px-3 py-2.5" onClick={make} disabled={busy} type="button">
            {busy ? "DRAWING…" : "Share on X"}
          </button>
          <span className="text-[11px] text-ink-soft">draws a card with this Broker&rsquo;s earnings</span>
        </div>
      ) : (
        <div className="grid gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={`Earnings card for Broker #${data.id}`} className="block w-full max-w-[520px] border-2 border-ink" />
          <div className="flex flex-wrap gap-2">
            <a className="btn btn-ghost text-[11px] px-3 py-2.5" href={url} download={fileName}>Download card</a>
            {canShareFiles() && (
              <button className="btn btn-ghost text-[11px] px-3 py-2.5" onClick={shareSheet} type="button">Share…</button>
            )}
            <a className="btn btn-accent text-[11px] px-3 py-2.5" href={intent} target="_blank" rel="noopener noreferrer">Post on X ↗</a>
          </div>
          <p className="text-[11px] text-ink-soft">The post opens with the text ready. Attach the downloaded card to it.</p>
        </div>
      )}
      {err && <p className="text-accent text-[12px] mt-1">{err}</p>}
    </div>
  );
}
