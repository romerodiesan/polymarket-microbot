"use client";

import { useMemo, useRef, useState } from "react";
import { Slider } from "@/components/ui/slider";
import type { ChartTheme } from "@/components/charts/theme";
import { fmtClock, fmtTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { LiveControlsState } from "./use-live-controls";

export type TimelineMark = { ts: number; side: "BUY" | "SELL" };

/** Fills closer than this fraction of the track collapse into one dot. */
const FILL_BUCKET = 0.004;

export function Timeline({ c, markets, fills, theme, compact }: {
  c: LiveControlsState;
  /** Start of every market (rollover) inside the range. */
  markets: number[];
  fills: TimelineMark[];
  theme: ChartTheme;
  compact?: boolean;
}) {
  const { min, max } = c.range;
  const span = Math.max(max - min, 1);
  const pct = (ts: number) => ((ts - min) / span) * 100;
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; ts: number } | null>(null);

  const fillDots = useMemo(() => {
    const buckets = new Map<number, TimelineMark>();
    for (const f of fills) {
      if (f.ts < min || f.ts > max) continue;
      buckets.set(Math.round((f.ts - min) / span / FILL_BUCKET), f);
    }
    return [...buckets.values()];
  }, [fills, min, max, span]);

  const rollovers = useMemo(() => markets.filter((ts) => ts > min && ts < max), [markets, min, max]);

  const onPointer = (e: React.PointerEvent) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || c.live) return;
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    setHover({ x, ts: min + (x / rect.width) * span });
  };

  return (
    <div className={cn("flex items-center gap-3", compact && "gap-2")}>
      <span className="w-[4.5rem] shrink-0 font-mono text-xs tabular-nums text-foreground max-sm:w-auto">{fmtTime(c.t)}</span>

      <div
        ref={trackRef}
        className="relative flex h-7 flex-1 items-center"
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setHover(null)}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-1.5">
          {fillDots.map((f) => (
            <span
              key={f.ts}
              className="absolute top-0 size-1.5 -translate-x-1/2 rounded-full"
              style={{ left: `${pct(f.ts)}%`, backgroundColor: f.side === "BUY" ? theme.buy : theme.sell }}
            />
          ))}
        </div>
        {rollovers.map((ts) => (
          <span
            key={ts}
            className="pointer-events-none absolute top-1/2 z-10 h-3 w-px -translate-y-1/2 bg-foreground/50"
            style={{ left: `${pct(ts)}%` }}
          />
        ))}
        <Slider
          min={min}
          max={Math.max(max, min + 1)}
          step={0.1}
          value={[c.t]}
          onValueChange={([v]) => c.seek(v)}
          disabled={c.live}
          aria-label="Momento de la reproducción"
          aria-valuetext={fmtTime(c.t)}
          className={cn(
            "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-100",
            c.live
              ? "[&_[data-slot=slider-range]]:bg-emerald-500/70 [&_[data-slot=slider-thumb]]:hidden"
              : "cursor-pointer [&_[data-slot=slider-range]]:bg-sky-500",
          )}
        />
        {hover && (
          <span
            className="pointer-events-none absolute -top-7 z-20 -translate-x-1/2 rounded-md bg-foreground px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-background shadow"
            style={{ left: hover.x }}
          >
            {fmtTime(hover.ts)}
          </span>
        )}
      </div>

      {c.live ? (
        <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-emerald-600 dark:text-emerald-400">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          EN VIVO
        </span>
      ) : (
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground" title="Tiempo restante hasta el último dato">
          −{fmtClock(max - c.t)}
        </span>
      )}
    </div>
  );
}
