// Two-step approve→action indicator for the one-click flows.
export type StepState = "idle" | "doing" | "done";

export function StepFlow({ steps }: { steps: { label: string; state: StepState }[] }) {
  const cls: Record<StepState, string> = {
    idle: "border-line text-ink-soft",
    doing: "border-warn text-warn",
    done: "border-good text-good",
  };
  return (
    <div className="flex gap-2 mt-3 text-xs">
      {steps.map((s, i) => (
        <div key={i} className={`flex-1 border px-2 py-2 text-center ${cls[s.state]}`}>
          {i + 1} · {s.label}
        </div>
      ))}
    </div>
  );
}
