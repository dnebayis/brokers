"use client";

import { useMemo } from "react";
import { useReadContract } from "wagmi";
import { ADDR } from "@/lib/config";
import { brokerAbi } from "@/lib/abis";

function imageFromTokenUri(tokenUri?: string) {
  const prefix = "data:application/json;base64,";
  if (!tokenUri?.startsWith(prefix)) return undefined;
  try {
    return JSON.parse(atob(tokenUri.slice(prefix.length))).image as string | undefined;
  } catch {
    return undefined;
  }
}

/** Displays the canonical SVG embedded by the on-chain BrokerRenderer. */
export function BrokerArtwork({ tokenId, size = 96 }: { tokenId: bigint; size?: number }) {
  const { data: tokenUri } = useReadContract({
    address: ADDR.broker,
    abi: brokerAbi,
    functionName: "tokenURI",
    args: [tokenId],
  });
  const image = useMemo(() => imageFromTokenUri(tokenUri), [tokenUri]);

  if (image) {
    // The renderer returns a fully on-chain data URI; Next's remote-image optimizer cannot fetch it.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={image} width={size} height={size} alt={`Coattail Broker #${tokenId}`} className="block" />;
  }
  return (
    <div
      className="grid place-items-center bg-cream text-ink-soft font-pixel text-[10px]"
      style={{ width: size, height: size }}
      aria-label={`Loading on-chain artwork for Broker #${tokenId}`}
    >
      #{tokenId.toString()}
    </div>
  );
}
