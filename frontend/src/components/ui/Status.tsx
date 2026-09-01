export type StatusKind = "" | "ok" | "err";

// aria-live so transaction progress and errors are announced, not just painted.
export function StatusLine({ msg, kind = "" }: { msg: string; kind?: StatusKind }) {
  const color = kind === "err" ? "text-accent" : kind === "ok" ? "text-good" : "text-ink-soft";
  return (
    <div
      className={`mt-3.5 min-h-[20px] text-sm ${msg ? color : ""}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {msg}
    </div>
  );
}
