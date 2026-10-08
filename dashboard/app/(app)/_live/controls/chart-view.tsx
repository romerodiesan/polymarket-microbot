"use client";

import { CandlestickChart, ChevronDown, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import { ChoiceGroup } from "@/components/app/choice-group";
import { autoInterval } from "@/components/charts/candles";
import type { ChartViewport } from "@/components/charts/chart-group";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useStoredState } from "@/hooks/use-stored-state";
import { CANDLE_SECONDS, INTERVALS, RANGES, intervalLabel } from "./options";
import type { TimeRange } from "./use-live-controls";

type StoredView = { windowSec: number; intervalChoice: number };

const sanitizers = new Map<number, (stored: Record<string, unknown>) => StoredView>();
const defaultsCache = new Map<number, StoredView>();

function defaultsFor(windowSec: number): StoredView {
  let defaults = defaultsCache.get(windowSec);
  if (!defaults) {
    defaults = { windowSec, intervalChoice: 0 };
    defaultsCache.set(windowSec, defaults);
  }
  return defaults;
}

function sanitizerFor(defaultWindow: number) {
  let sanitize = sanitizers.get(defaultWindow);
  if (!sanitize) {
    sanitize = (stored) => {
      const windowSec = stored.windowSec === null ? Infinity : stored.windowSec;
      const intervalChoice = stored.intervalChoice;
      return {
        windowSec: RANGES.some((r) => r.value === windowSec) ? (windowSec as number) : defaultWindow,
        intervalChoice: INTERVALS.some((i) => i.value === intervalChoice) ? (intervalChoice as number) : 0,
      };
    };
    sanitizers.set(defaultWindow, sanitize);
  }
  return sanitize;
}

/** Range and candle size of one chart, persisted per chart id, plus whether it follows the clock. */
export function useChartView(id: string, range: TimeRange | null, defaultWindow = 900) {
  const [stored, update] = useStoredState(`microbot.chart.${id}`, defaultsFor(defaultWindow), sanitizerFor(defaultWindow));
  const [following, setFollowing] = useState(true);

  const span = Number.isFinite(stored.windowSec)
    ? stored.windowSec
    : Math.max(60, (range?.max ?? 0) - (range?.min ?? 0));
  const interval = stored.intervalChoice || autoInterval(span, CANDLE_SECONDS);

  const viewport = useMemo<ChartViewport>(
    () => ({ windowSec: stored.windowSec, following, onFollowingChange: setFollowing }),
    [stored.windowSec, following],
  );

  return {
    ...stored,
    interval,
    following,
    viewport,
    setWindowSec: (windowSec: number) => {
      update({ windowSec });
      setFollowing(true);
    },
    setIntervalChoice: (intervalChoice: number) => update({ intervalChoice }),
    follow: () => setFollowing(true),
  };
}

export type ChartView = ReturnType<typeof useChartView>;

/** Per-chart range, candle size and "back to the edge" chip, shown above the chart. */
export function ChartViewBar({ view, live, candles = true }: { view: ChartView; live: boolean; candles?: boolean }) {
  const noun = candles ? "Velas" : "Resolución";
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <ChoiceGroup label="Rango visible" options={RANGES} value={view.windowSec} onChange={view.setWindowSec} />
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
            <CandlestickChart />
            <span className="max-sm:hidden">{noun}</span>
            <span className="font-mono text-muted-foreground">
              {view.intervalChoice ? intervalLabel(view.intervalChoice) : `Auto · ${intervalLabel(view.interval)}`}
            </span>
            <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto">
          <p className="mb-2 text-sm font-medium">{candles ? "Tamaño de vela" : "Resolución"}</p>
          <ChoiceGroup label={noun} options={INTERVALS} value={view.intervalChoice} onChange={view.setIntervalChoice} />
          <p className="mt-2 text-xs text-muted-foreground">
            {view.intervalChoice
              ? "Tamaño fijo para esta gráfica."
              : `Automático según el rango: ahora ${intervalLabel(view.interval)}.`}
          </p>
        </PopoverContent>
      </Popover>
      {!view.following && (
        <Button size="sm" variant="secondary" onClick={view.follow} className="ml-auto h-8 gap-1 px-2.5 text-xs">
          <Undo2 />
          {live ? "Volver a tiempo real" : "Seguir el cursor"}
        </Button>
      )}
    </div>
  );
}
