export type StatusKind = "" | "ok" | "err";

export function StatusLine({ msg, kind = "" }: { msg: string; kind?: StatusKind }) {
  if (!msg) return <div className="mt-3.5 min-h-[20px] text-sm" />;
  const color = kind === "err" ? "text-accent" : kind === "ok" ? "text-good" : "text-ink-soft";
  return <div className={`mt-3.5 min-h-[20px] text-sm ${color}`}>{msg}</div>;
}
