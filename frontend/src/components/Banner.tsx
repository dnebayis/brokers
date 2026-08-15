import { ACTIVE_NETWORK, activeChain } from "@/lib/chains";

export function Banner({ onDocs }: { onDocs: () => void }) {
  if (ACTIVE_NETWORK !== "testnet") return null;
  return (
    <div
      className="border-b border-line text-center text-[12.5px] text-ink-strong py-1.5 px-3"
      style={{
        backgroundImage:
          "repeating-linear-gradient(45deg,#E4DED2,#E4DED2 8px,#F5F2EB 8px,#F5F2EB 16px)",
      }}
    >
      <b className="text-accent">TESTNET</b> · {activeChain.name} {activeChain.id} · test tokens, not real
      funds. Verify every address in{" "}
      <button onClick={onDocs} className="underline text-accent">
        Docs
      </button>{" "}
      before you sign.
    </div>
  );
}
