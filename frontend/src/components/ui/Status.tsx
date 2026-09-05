import { explorerTx } from "@/lib/chains";

export type StatusKind = "" | "ok" | "err";

// aria-live so transaction progress and errors are announced, not just painted. When the
// run has sent a transaction, its hash links to the explorer next to the message.
export function StatusLine({ msg, kind = "", hash }: { msg: string; kind?: StatusKind; hash?: `0x${string}` }) {
  const color = kind === "err" ? "text-accent" : kind === "ok" ? "text-good" : "text-ink-soft";
  return (
    <div
      className={`mt-3.5 min-h-[20px] text-sm ${msg ? color : ""}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {msg}
      {hash && (
        <>
          {msg ? " · " : ""}
          <a href={explorerTx(hash)} target="_blank" rel="noopener noreferrer"
            className="font-pixel text-[11px] underline hover:text-ink-strong" title={hash}>
            tx {hash.slice(0, 6)}…{hash.slice(-4)} ↗
          </a>
        </>
      )}
    </div>
  );
}
