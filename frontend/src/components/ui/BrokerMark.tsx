// The pixel-broker wordmark glyph: suit, tie, flag pin — the collection in 10x10 pixels.
export function BrokerMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" className="pixelate" aria-hidden="true">
      <rect x="3" y="1" width="4" height="3" fill="#4E5666" />
      <rect x="2" y="2" width="1" height="2" fill="#4E5666" />
      <rect x="7" y="2" width="1" height="2" fill="#4E5666" />
      <rect x="2" y="5" width="6" height="3" fill="#4E5666" />
      <rect x="4" y="5" width="2" height="3" fill="#F5F2EB" />
      <rect x="4" y="5" width="2" height="1" fill="#A6412F" />
    </svg>
  );
}
