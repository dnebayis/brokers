"use client";

// Dependency-free SVG charts in the site's 1-bit idiom: crisp edges, pixel-font axes, ink on
// cream, the brand tokens for every colour so both themes work. Each chart measures its own
// container and redraws at that width; heights are fixed per chart. Time axes take unix
// seconds; every number the reader sees goes through the caller's formatter.

import { useCallback, useMemo, useState } from "react";

export const SERIES_COLORS = [
  "var(--c-ink)", "var(--c-accent)", "var(--c-good)", "var(--c-warn)",
  "var(--c-ink-soft)", "url(#hatch-ink)", "url(#hatch-accent)", "url(#hatch-good)", "var(--c-line)", "url(#hatch-warn)",
];

const FONT = { fontFamily: "var(--font-silkscreen), monospace", fontSize: 9 } as const;
const PAD = { top: 10, right: 12, bottom: 22, left: 44 };

// A callback ref: measures the container when it mounts and follows it with a
// ResizeObserver, so no ref value is ever read during render.
function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [w, setW] = useState(0);
  const [ro] = useState(() => (typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
    for (const e of entries) setW(Math.floor(e.contentRect.width));
  })));
  const ref = useCallback((el: T | null) => {
    if (!ro) return;
    ro.disconnect();
    if (el) { setW(el.clientWidth); ro.observe(el); }
  }, [ro]);
  return [ref, w];
}

/** Round-number axis ticks covering [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!isFinite(min) || !isFinite(max)) return [];
  if (max === min) return [min];
  const span = max - min;
  const rough = span / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

const dayLabel = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function timeTicks(min: number, max: number, width: number): number[] {
  const want = Math.max(2, Math.min(7, Math.floor(width / 90)));
  const DAY = 86_400;
  const spanDays = Math.max(1, (max - min) / DAY);
  const stepDays = Math.max(1, Math.ceil(spanDays / want));
  const out: number[] = [];
  const start = Math.ceil(min / DAY) * DAY;
  for (let t = start; t <= max; t += stepDays * DAY) out.push(t);
  return out;
}

export function Patterns() {
  const hatch = (id: string, color: string) => (
    <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="4" height="4" fill="var(--c-cream)" />
      <rect width="2" height="4" fill={color} />
    </pattern>
  );
  return (
    <defs>
      {hatch("hatch-ink", "var(--c-ink)")}
      {hatch("hatch-accent", "var(--c-accent)")}
      {hatch("hatch-good", "var(--c-good)")}
      {hatch("hatch-warn", "var(--c-warn)")}
    </defs>
  );
}

export type Series = { name: string; points: { x: number; y: number }[]; color?: string; dashed?: boolean };

/**
 * Lines over a time axis. `area` fills under the first series. Hover shows a crosshair
 * with every series' value at the nearest x.
 */
export function LineChart({ series, height = 220, yFormat, area = false, yMin0 = true, xFormat = dayLabel, hint }: {
  series: Series[]; height?: number; yFormat: (v: number) => string; area?: boolean; yMin0?: boolean;
  xFormat?: (ts: number) => string; hint?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const all = series.flatMap((s) => s.points);
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yLo = yMin0 ? Math.min(0, ...ys) : Math.min(...ys);
  const yHi = Math.max(...ys);
  const yTicks = niceTicks(yLo, yHi === yLo ? yLo + 1 : yHi, 4);
  const yMin = Math.min(yLo, yTicks[0] ?? yLo), yMax = Math.max(yHi, yTicks[yTicks.length - 1] ?? yHi);
  const iw = Math.max(0, width - PAD.left - PAD.right), ih = height - PAD.top - PAD.bottom;
  const sx = (x: number) => PAD.left + (xMax === xMin ? iw / 2 : ((x - xMin) / (xMax - xMin)) * iw);
  const sy = (y: number) => PAD.top + ih - ((y - yMin) / (yMax - yMin || 1)) * ih;
  const xTicks = useMemo(() => timeTicks(xMin, xMax, iw), [xMin, xMax, iw]);

  if (all.length === 0) return <Empty height={height} />;

  const path = (pts: { x: number; y: number }[]) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(" ");

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < PAD.left || px > width - PAD.right) { setHover(null); return; }
    const x = xMin + ((px - PAD.left) / (iw || 1)) * (xMax - xMin);
    setHover(x);
  }
  const nearest = (s: Series, x: number) => {
    let best = s.points[0];
    for (const p of s.points) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
    return best;
  };

  return (
    <div ref={ref} className="w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} className="block overflow-visible" role="img" aria-label={hint}
          onMouseMove={onMove} onMouseLeave={() => setHover(null)} shapeRendering="crispEdges">
          <Patterns />
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={sy(t)} y2={sy(t)} stroke="var(--c-line)" strokeWidth={1} />
              <text x={PAD.left - 6} y={sy(t) + 3} textAnchor="end" fill="var(--c-ink-soft)" style={FONT}>{yFormat(t)}</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={sx(t)} y={height - 6} textAnchor="middle" fill="var(--c-ink-soft)" style={FONT}>{xFormat(t)}</text>
          ))}
          <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + ih} y2={PAD.top + ih} stroke="var(--c-ink)" strokeWidth={1.5} />
          {series.map((s, i) => {
            const color = s.color ?? SERIES_COLORS[i % SERIES_COLORS.length];
            if (s.points.length === 0) return null;
            const d = path(s.points);
            return (
              <g key={s.name}>
                {area && i === 0 && (
                  <path d={`${d} L${sx(s.points[s.points.length - 1].x).toFixed(1)} ${sy(yMin)} L${sx(s.points[0].x).toFixed(1)} ${sy(yMin)} Z`}
                    fill={color} opacity={0.14} shapeRendering="auto" />
                )}
                <path d={d} fill="none" stroke={color} strokeWidth={2} strokeDasharray={s.dashed ? "4 3" : undefined}
                  strokeLinejoin="miter" shapeRendering="auto" />
              </g>
            );
          })}
          {hover !== null && (() => {
            const hits = series.filter((s) => s.points.length).map((s, i) => ({ s, i, p: nearest(s, hover) }));
            const hx = sx(hits[0].p.x);
            const boxW = 150, lineH = 12;
            const boxH = lineH * (hits.length + 1) + 8;
            const bx = hx + 10 + boxW > width ? hx - 10 - boxW : hx + 10;
            return (
              <g>
                <line x1={hx} x2={hx} y1={PAD.top} y2={PAD.top + ih} stroke="var(--c-ink)" strokeWidth={1} strokeDasharray="2 2" />
                {hits.map(({ s, i, p }) => (
                  <rect key={s.name} x={sx(p.x) - 2.5} y={sy(p.y) - 2.5} width={5} height={5}
                    fill={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]} />
                ))}
                <rect x={bx} y={PAD.top} width={boxW} height={boxH} fill="var(--c-cream2)" stroke="var(--c-ink)" strokeWidth={1.5} />
                <text x={bx + 6} y={PAD.top + 12} fill="var(--c-ink-strong)" style={FONT}>{xFormat(hits[0].p.x)}</text>
                {hits.map(({ s, p }, k) => (
                  <text key={s.name} x={bx + 6} y={PAD.top + 12 + lineH * (k + 1)} fill="var(--c-ink)" style={FONT}>
                    {s.name}: {yFormat(p.y)}
                  </text>
                ))}
              </g>
            );
          })()}
        </svg>
      )}
    </div>
  );
}

/** Vertical bars over a time axis (one bar per bucket). */
export function BarChart({ points, height = 160, yFormat, color = "var(--c-ink)", xFormat = dayLabel, hint }: {
  points: { x: number; y: number }[]; height?: number; yFormat: (v: number) => string; color?: string;
  xFormat?: (ts: number) => string; hint?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return <Empty height={height} />;
  const xMin = points[0].x, xMax = points[points.length - 1].x;
  const yHi = Math.max(0, ...points.map((p) => p.y));
  const yTicks = niceTicks(0, yHi || 1, 3);
  const yMax = Math.max(yHi, yTicks[yTicks.length - 1] ?? yHi) || 1;
  const iw = Math.max(0, width - PAD.left - PAD.right), ih = height - PAD.top - PAD.bottom;
  const n = points.length;
  const slot = iw / n;
  const bw = Math.max(1, Math.floor(slot * 0.7));
  const sx = (i: number) => PAD.left + i * slot + (slot - bw) / 2;
  const sy = (y: number) => PAD.top + ih - (y / yMax) * ih;
  const xTicks = timeTicks(xMin, xMax, iw);
  const xOf = (t: number) => PAD.left + (xMax === xMin ? iw / 2 : ((t - xMin) / (xMax - xMin)) * (iw - slot) + slot / 2);
  return (
    <div ref={ref} className="w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} className="block overflow-visible" role="img" aria-label={hint} shapeRendering="crispEdges"
          onMouseLeave={() => setHover(null)}>
          <Patterns />
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={sy(t)} y2={sy(t)} stroke="var(--c-line)" />
              <text x={PAD.left - 6} y={sy(t) + 3} textAnchor="end" fill="var(--c-ink-soft)" style={FONT}>{yFormat(t)}</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={xOf(t)} y={height - 6} textAnchor="middle" fill="var(--c-ink-soft)" style={FONT}>{xFormat(t)}</text>
          ))}
          <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + ih} y2={PAD.top + ih} stroke="var(--c-ink)" strokeWidth={1.5} />
          {points.map((p, i) => (
            <rect key={p.x} x={sx(i)} y={sy(p.y)} width={bw} height={Math.max(0, PAD.top + ih - sy(p.y))}
              fill={hover === i ? "var(--c-accent)" : color} onMouseEnter={() => setHover(i)}>
              <title>{xFormat(p.x)}: {yFormat(p.y)}</title>
            </rect>
          ))}
          {hover !== null && (
            <text x={Math.min(width - PAD.right - 4, Math.max(PAD.left + 4, sx(hover) + bw / 2))} y={PAD.top + 2}
              textAnchor="middle" fill="var(--c-ink-strong)" style={FONT}>
              {xFormat(points[hover].x)} · {yFormat(points[hover].y)}
            </text>
          )}
        </svg>
      )}
    </div>
  );
}

/** Horizontal labelled bars, largest first is the caller's job. Optional second value drawn as a hatched bar. */
export function HBarChart({ rows, format, format2, hint, color = "var(--c-ink)", color2 = "url(#hatch-accent)", labelWidth = 72 }: {
  rows: { label: string; value: number; value2?: number; tone?: string; note?: string }[];
  format: (v: number) => string; format2?: (v: number) => string; hint?: string; color?: string; color2?: string; labelWidth?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const rowH = 22, gap = 6;
  const height = rows.length * (rowH + gap) + 4;
  if (rows.length === 0) return <Empty height={80} />;
  const max = Math.max(...rows.flatMap((r) => [r.value, r.value2 ?? 0]), 0) || 1;
  const valueW = 78;
  const iw = Math.max(0, width - labelWidth - valueW - 8);
  const two = rows.some((r) => r.value2 !== undefined);
  return (
    <div ref={ref} className="w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} className="block" role="img" aria-label={hint} shapeRendering="crispEdges">
          <Patterns />
          {rows.map((r, i) => {
            const y = 2 + i * (rowH + gap);
            const w1 = (Math.max(0, r.value) / max) * iw;
            const w2 = ((r.value2 ?? 0) / max) * iw;
            const h = two ? rowH / 2 - 1 : rowH;
            return (
              <g key={r.label}>
                <text x={labelWidth - 6} y={y + rowH / 2 + 3} textAnchor="end" fill="var(--c-ink-strong)" style={FONT}>{r.label}</text>
                <rect x={labelWidth} y={y} width={Math.max(w1, r.value > 0 ? 1 : 0)} height={h} fill={r.tone ?? color}>
                  <title>{r.label}: {format(r.value)}{r.note ? ` · ${r.note}` : ""}</title>
                </rect>
                {two && (
                  <rect x={labelWidth} y={y + h + 2} width={Math.max(w2, (r.value2 ?? 0) > 0 ? 1 : 0)} height={h} fill={color2}>
                    <title>{r.label}: {(format2 ?? format)(r.value2 ?? 0)}</title>
                  </rect>
                )}
                <text x={labelWidth + Math.max(w1, w2) + 6} y={y + rowH / 2 + 3} fill="var(--c-ink)" style={FONT}>
                  {format(r.value)}{two && format2 ? ` / ${format2(r.value2 ?? 0)}` : ""}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/** Weights that sum to a whole, stacked over time (basket composition). */
export function StackedArea({ keys, rows, height = 240, hint, xFormat = dayLabel }: {
  keys: string[]; rows: { x: number; values: Record<string, number> }[]; height?: number; hint?: string; xFormat?: (ts: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (rows.length === 0 || keys.length === 0) return <Empty height={height} />;
  const xMin = rows[0].x, xMax = rows[rows.length - 1].x;
  const iw = Math.max(0, width - PAD.left - PAD.right), ih = height - PAD.top - PAD.bottom;
  const sx = (x: number) => PAD.left + (xMax === xMin ? iw / 2 : ((x - xMin) / (xMax - xMin)) * iw);
  const sy = (v: number) => PAD.top + ih - v * ih;
  // Cumulative tops per key so each band sits on the one below it.
  const bands = keys.map((k, ki) => rows.map((r) => {
    let below = 0;
    for (let j = 0; j < ki; j++) below += r.values[keys[j]] ?? 0;
    return { x: r.x, y0: below, y1: below + (r.values[k] ?? 0) };
  }));
  const xTicks = timeTicks(xMin, xMax, iw);
  const hovered = hover === null ? null : rows[hover];
  return (
    <div ref={ref} className="w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} className="block overflow-visible" role="img" aria-label={hint}
          onMouseMove={(e) => {
            const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
            if (px < PAD.left || px > width - PAD.right) { setHover(null); return; }
            const x = xMin + ((px - PAD.left) / (iw || 1)) * (xMax - xMin);
            let best = 0;
            for (let i = 1; i < rows.length; i++) if (Math.abs(rows[i].x - x) < Math.abs(rows[best].x - x)) best = i;
            setHover(best);
          }}
          onMouseLeave={() => setHover(null)}>
          <Patterns />
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={sy(t)} y2={sy(t)} stroke="var(--c-line)" shapeRendering="crispEdges" />
              <text x={PAD.left - 6} y={sy(t) + 3} textAnchor="end" fill="var(--c-ink-soft)" style={FONT}>{Math.round(t * 100)}%</text>
            </g>
          ))}
          {bands.map((b, i) => {
            const top = b.map((p, j) => `${j === 0 ? "M" : "L"}${sx(p.x).toFixed(1)} ${sy(p.y1).toFixed(1)}`).join(" ");
            const bottom = [...b].reverse().map((p) => `L${sx(p.x).toFixed(1)} ${sy(p.y0).toFixed(1)}`).join(" ");
            return <path key={keys[i]} d={`${top} ${bottom} Z`} fill={SERIES_COLORS[i % SERIES_COLORS.length]} stroke="var(--c-cream2)" strokeWidth={0.5} />;
          })}
          {xTicks.map((t) => (
            <text key={t} x={sx(t)} y={height - 6} textAnchor="middle" fill="var(--c-ink-soft)" style={FONT} shapeRendering="crispEdges">{xFormat(t)}</text>
          ))}
          <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + ih} y2={PAD.top + ih} stroke="var(--c-ink)" strokeWidth={1.5} shapeRendering="crispEdges" />
          {hovered && (() => {
            const hx = sx(hovered.x);
            const live = keys.filter((k) => (hovered.values[k] ?? 0) > 0);
            const boxW = 120, lineH = 12, boxH = lineH * (live.length + 1) + 8;
            const bx = hx + 10 + boxW > width ? hx - 10 - boxW : hx + 10;
            return (
              <g shapeRendering="crispEdges">
                <line x1={hx} x2={hx} y1={PAD.top} y2={PAD.top + ih} stroke="var(--c-ink)" strokeDasharray="2 2" />
                <rect x={bx} y={PAD.top} width={boxW} height={boxH} fill="var(--c-cream2)" stroke="var(--c-ink)" strokeWidth={1.5} />
                <text x={bx + 6} y={PAD.top + 12} fill="var(--c-ink-strong)" style={FONT}>{xFormat(hovered.x)}</text>
                {live.map((k, i) => (
                  <text key={k} x={bx + 6} y={PAD.top + 12 + lineH * (i + 1)} fill="var(--c-ink)" style={FONT}>
                    {k}: {Math.round((hovered.values[k] ?? 0) * 100)}%
                  </text>
                ))}
              </g>
            );
          })()}
        </svg>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { name: string; color?: string; index?: number }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2">
      {items.map((it, i) => {
        const fill = it.color ?? SERIES_COLORS[(it.index ?? i) % SERIES_COLORS.length];
        return (
          <span key={it.name} className="inline-flex items-center gap-1.5 font-pixel text-[9px] text-ink">
            <svg width="10" height="10" aria-hidden="true"><Patterns /><rect width="10" height="10" fill={fill} /></svg>
            {it.name}
          </span>
        );
      })}
    </div>
  );
}

function Empty({ height }: { height: number }) {
  return (
    <div className="w-full flex items-center justify-center border border-dashed border-line text-ink-soft text-sm" style={{ height }}>
      nothing to chart yet
    </div>
  );
}
