"use client";

import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  BaselineSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

export type TimePoint = { ts: number; value: number };

export type ChartMarker = {
  ts: number;
  price: number;
  kind: "buy" | "sell";
  text?: string;
};

export type ChartSeries = {
  id: string;
  label: string;
  type: "line" | "area" | "baseline";
  color: string;
  data: TimePoint[];
  lineWidth?: 1 | 2 | 3;
  dashed?: boolean;
  /** Baseline series: values above are green, below red. */
  baseValue?: number;
  priceLines?: { price: number; color: string; title?: string }[];
  markers?: ChartMarker[];
  /** Hidden from the legend (still drawn). */
  hideInLegend?: boolean;
};

const UP = "#22c55e";
const DOWN = "#ef4444";

const timeLabel = (time: Time, withSeconds = true) =>
  new Date((time as number) * 1000).toLocaleTimeString("es", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  });

/** Whole seconds, strictly increasing, keeping the last value of each second. */
function toSeriesData(points: TimePoint[]) {
  const out: { time: UTCTimestamp; value: number }[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.value) || !Number.isFinite(p.ts)) continue;
    const time = Math.floor(p.ts) as UTCTimestamp;
    const last = out.at(-1);
    if (last && last.time === time) last.value = p.value;
    else if (!last || time > last.time) out.push({ time, value: p.value });
  }
  return out;
}

/** Markers must sit on an existing bar, so snap each one to the nearest data time. */
function toMarkers(markers: ChartMarker[], times: UTCTimestamp[]): SeriesMarker<Time>[] {
  if (!times.length) return [];
  return markers
    .map((m) => {
      let lo = 0;
      let hi = times.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] < m.ts) lo = mid + 1;
        else hi = mid;
      }
      const time = lo > 0 && Math.abs(times[lo - 1] - m.ts) < Math.abs(times[lo] - m.ts) ? times[lo - 1] : times[lo];
      const buy = m.kind === "buy";
      return {
        time,
        price: m.price,
        position: buy ? "atPriceBottom" : "atPriceTop",
        shape: buy ? "arrowUp" : "arrowDown",
        color: buy ? "#22d3ee" : "#f97316",
        text: m.text,
      } satisfies SeriesMarker<Time>;
    })
    .sort((a, b) => (a.time as number) - (b.time as number));
}

type Entry = {
  type: ChartSeries["type"];
  api: ISeriesApi<SeriesType>;
  markers: ISeriesMarkersPluginApi<Time> | null;
  priceLines: IPriceLine[];
};

type Legend = { time: Time | null; values: Record<string, number | undefined> };

export function TimeSeries({
  series,
  height = 260,
  precision = 3,
  fitKey,
}: {
  series: ChartSeries[];
  height?: number;
  precision?: number;
  /** Changing this value refits the visible range to the data. */
  fitKey?: string | number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const entriesRef = useRef(new Map<string, Entry>());
  const seriesRef = useRef(series);
  const fittedKeyRef = useRef<string | number | undefined>(undefined);
  const [legend, setLegend] = useState<Legend>({ time: null, values: {} });

  useEffect(() => {
    seriesRef.current = series;
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#a1a1aa",
        fontSize: 11,
        fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.06)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(255,255,255,0.25)", labelBackgroundColor: "#27272a" },
        horzLine: { color: "rgba(255,255,255,0.25)", labelBackgroundColor: "#27272a" },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: true,
        tickMarkFormatter: (time: Time) => timeLabel(time, false),
      },
      localization: { timeFormatter: (time: Time) => timeLabel(time) },
    });
    chartRef.current = chart;
    const entries = entriesRef.current;

    const onMove = (param: MouseEventParams<Time>) => {
      if (param.time === undefined) {
        setLegend({ time: null, values: {} });
        return;
      }
      const values: Legend["values"] = {};
      for (const [id, entry] of entries) {
        const point = param.seriesData.get(entry.api) as { value?: number } | undefined;
        values[id] = point?.value;
      }
      setLegend({ time: param.time, values });
    };
    chart.subscribeCrosshairMove(onMove);

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      entries.clear();
      fittedKeyRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const entries = entriesRef.current;
    const priceFormat = { type: "price" as const, precision, minMove: 10 ** -precision };

    for (const [id, entry] of entries) {
      const next = series.find((s) => s.id === id);
      if (!next || next.type !== entry.type) {
        chart.removeSeries(entry.api);
        entries.delete(id);
      }
    }

    let hasData = false;
    for (const s of series) {
      let entry = entries.get(s.id);
      const common = {
        lineWidth: s.lineWidth ?? 2,
        lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceFormat,
        lastValueVisible: !s.hideInLegend,
        priceLineVisible: false,
      };
      if (!entry) {
        const api =
          s.type === "area"
            ? chart.addSeries(AreaSeries, {
                ...common,
                lineColor: s.color,
                topColor: `${s.color}55`,
                bottomColor: `${s.color}05`,
              })
            : s.type === "baseline"
              ? chart.addSeries(BaselineSeries, {
                  ...common,
                  baseValue: { type: "price", price: s.baseValue ?? 0 },
                  topLineColor: UP,
                  topFillColor1: `${UP}40`,
                  topFillColor2: `${UP}05`,
                  bottomLineColor: DOWN,
                  bottomFillColor1: `${DOWN}05`,
                  bottomFillColor2: `${DOWN}40`,
                })
              : chart.addSeries(LineSeries, { ...common, color: s.color });
        entry = { type: s.type, api, markers: null, priceLines: [] };
        entries.set(s.id, entry);
      } else if (s.type === "baseline") {
        entry.api.applyOptions({ ...common, baseValue: { type: "price", price: s.baseValue ?? 0 } });
      } else {
        entry.api.applyOptions(s.type === "area" ? { ...common, lineColor: s.color } : { ...common, color: s.color });
      }

      const data = toSeriesData(s.data);
      hasData ||= data.length > 0;
      entry.api.setData(data);

      for (const line of entry.priceLines) entry.api.removePriceLine(line);
      entry.priceLines = (s.priceLines ?? []).map((line) =>
        entry.api.createPriceLine({
          price: line.price,
          color: line.color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: line.title ?? "",
        }),
      );

      const markers = toMarkers(s.markers ?? [], data.map((d) => d.time));
      if (entry.markers) entry.markers.setMarkers(markers);
      else if (markers.length) entry.markers = createSeriesMarkers(entry.api, markers);
    }

    const key = fitKey ?? "default";
    if (hasData && fittedKeyRef.current !== key) {
      chart.timeScale().fitContent();
      fittedKeyRef.current = key;
    }
  }, [series, precision, fitKey]);

  const legendSeries = series.filter((s) => !s.hideInLegend);
  const hovering = legend.time !== null;
  return (
    <div className="relative w-full" style={{ height }}>
      <div ref={containerRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute left-2 top-1 z-10 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {hovering && <span className="text-zinc-500">{timeLabel(legend.time as Time)}</span>}
        {legendSeries.map((s) => {
          const value = hovering ? legend.values[s.id] : s.data.at(-1)?.value;
          return (
            <span key={s.id} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: s.type === "baseline" ? UP : s.color }} />
              <span className="text-zinc-400">{s.label}</span>
              <span className="tabular-nums text-zinc-100">
                {value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(precision)}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
