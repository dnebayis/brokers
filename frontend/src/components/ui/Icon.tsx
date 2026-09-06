// Dependency-free line-icon set (24x24, stroke = currentColor). Clean, not sloppy.
type Name =
  | "swap" | "power" | "book" | "wallet" | "search" | "home"
  | "download" | "plus" | "minus" | "flip" | "check" | "copy" | "external" | "arrow-right" | "list" | "route" | "trophy" | "chart" | "sun" | "moon";

const paths: Record<Name, React.ReactNode> = {
  swap: <><path d="M7 7h13l-3-3" /><path d="M17 17H4l3 3" /></>,
  power: <><path d="M12 3v9" /><path d="M6.6 6.6a8 8 0 1 0 10.8 0" /></>,
  book: <><path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2Z" /><path d="M4 5v14" /></>,
  wallet: <><path d="M3 7a2 2 0 0 1 2-2h12v4" /><path d="M3 7v10a2 2 0 0 0 2 2h14V9H5a2 2 0 0 1-2-2Z" /><circle cx="16" cy="14" r="1" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  download: <><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M5 21h14" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  minus: <><path d="M5 12h14" /></>,
  flip: <><path d="M8 3 5 6l3 3" /><path d="M5 6h9a5 5 0 0 1 5 5" /><path d="m16 21 3-3-3-3" /><path d="M19 18h-9a5 5 0 0 1-5-5" /></>,
  check: <><path d="m5 12 4 4L19 6" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="1" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></>,
  external: <><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>,
  "arrow-right": <><path d="M4 12h16" /><path d="m14 6 6 6-6 6" /></>,
  list: <><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3.5 6h.01" /><path d="M3.5 12h.01" /><path d="M3.5 18h.01" /></>,
  home: <><path d="m3 11 9-7 9 7" /><path d="M5 10v10h14V10" /><path d="M9 20v-6h6v6" /></>,
  route: <><path d="M6 4v16" /><path d="M6 5h9l-2 2 2 2H6" /><circle cx="6" cy="20" r="1" /></>,
  trophy: <><path d="M8 4h8v4a4 4 0 0 1-8 0Z" /><path d="M8 5H5v2a3 3 0 0 0 3 3" /><path d="M16 5h3v2a3 3 0 0 1-3 3" /><path d="M12 12v4" /><path d="M9 20h6" /><path d="M10 16h4l1 4H9Z" /></>,
  chart: <><path d="M4 20h16" /><path d="M6 17v-5" /><path d="M11 17V7" /><path d="M16 17v-8" /><path d="M21 17V4" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M19.4 4.6l-2.1 2.1M6.7 17.3l-2.1 2.1" /></>,
  moon: <><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" /></>,
};

export function Icon({ name, className = "w-4 h-4" }: { name: Name; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
