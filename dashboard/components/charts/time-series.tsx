"use client";

import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
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
import type { Candle } from "./candles";
import { type ChartViewport, type GroupMember, useChartGroup } from "./chart-group";

const DEFAULT_VIEWPORT: ChartViewport = { windowSec: Infinity, following: true, onFollowingChange: () => {} };
import { cn } from "@/lib/utils";
import { type Separator, SeparatorsPrimitive } from "./separators";
import { type ChartTheme, useChartTheme, withAlpha } from "./theme";

export type TimePoint = { ts: number; value: number; color?: string };

export type ChartMarker = {
  ts: number;
  price: number;
  /** `settle`: a position paid out at the market's resolution (0 or 1). */
  kind: "buy" | "sell" | "settle";
  text?: string;
};

type BaseSeries = {
  id: string;
  label: string;
  color: string;
  /** 0 = main pane, 1 = lower pane (e.g. volume). */
  pane?: 0 | 1;
  /** Decimals for this series; defaults to the chart's `precision`. */
  precision?: number;
  lineWidth?: 1 | 2 | 3;
  dashed?: boolean;
  priceLines?: { price: number; color: string; title?: string }[];
  markers?: ChartMarker[];
  /** Hidden from the legend (still drawn). */
  hideInLegend?: boolean;
};

export type ChartSeries =
  | (BaseSeries & { type: "line" | "area" | "histogram"; data: TimePoint[] })
  /** Baseline: values above `baseValue` are green, below red. */
  | (BaseSeries & { type: "baseline"; data: TimePoint[]; baseValue?: number })
  | (BaseSeries & { type: "candles"; data: Candle[] });

const timeLabel = (time: Time, withSeconds = true) =>
  new Date((time as number) * 1000).toLocaleTimeString("es", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  });

const tickLabel = (time: Time, tickType: number) => {
  const date = new Date((time as number) * 1000);
  // TickMarkType: 0 year, 1 month, 2 day of month, 3 time, 4 time with seconds.
  if (tickType <= 2) return date.toLocaleDateString("es", { day: "2-digit", month: "short" });
  return timeLabel(time, tickType === 4);
};

const fullTime = (ts: number, format?: (ts: number) => string) =>
  format?.(ts) ?? new Date(ts * 1000).toLocaleString("es", { hour12: false, dateStyle: "short", timeStyle: "medium" });

/** Whole seconds, strictly increasing, keeping the last value of each second. */
function toLineData(points: TimePoint[]) {
  const out: { time: UTCTimestamp; value: number; color?: string }[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.value) || !Number.isFinite(p.ts)) continue;
    const time = Math.floor(p.ts) as UTCTimestamp;
    const point = p.color ? { time, value: p.value, color: p.color } : { time, value: p.value };
    const last = out.at(-1);
    if (last && last.time === time) out[out.length - 1] = point;
    else if (!last || time > last.time) out.push(point);
  }
  return out;
}

function toCandleData(candles: Candle[]) {
  return candles.map((c) => ({ time: c.ts as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
}

/** Markers must sit on an existing bar, so snap each one to the nearest data time. */
function toMarkers(markers: ChartMarker[], times: UTCTimestamp[], T: ChartTheme): SeriesMarker<Time>[] {
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
      if (m.kind === "settle") {
        // Pinned above the bar: the payout (0 or 1) would otherwise stretch the price scale.
        return {
          time,
          position: "aboveBar",
          shape: "square",
          color: T.violet,
          text: m.text,
        } satisfies SeriesMarker<Time>;
      }
      return {
        time,
        price: m.price,
        position: buy ? "atPriceBottom" : "atPriceTop",
        shape: buy ? "arrowUp" : "arrowDown",
        color: buy ? T.buy : T.sell,
        text: m.text,
      } satisfies SeriesMarker<Time>;
    })
    .sort((a, b) => (a.time as number) - (b.time as number));
}

type BarData = ReturnType<typeof toLineData>[number] | ReturnType<typeof toCandleData>[number];

/** What a series last received, to send only the tail when the next data extends it. */
type Sent = {
  length: number;
  first: unknown;
  /** Element before the last; the last one may still be changing (live candle). */
  penultimate: unknown;
  times: UTCTimestamp[];
  markers: ChartMarker[];
};

type Entry = {
  key: string;
  api: ISeriesApi<SeriesType>;
  markers: ISeriesMarkersPluginApi<Time> | null;
  priceLines: IPriceLine[];
  priceLinesKey: string;
  sent: Sent | null;
};

const toBars = (s: ChartSeries, data: ChartSeries["data"]): BarData[] =>
  s.type === "candles" ? toCandleData(data as Candle[]) : toLineData(data as TimePoint[]);

/**
 * Sends `s.data` to the chart. When it starts with the same objects as last time (the producers
 * reuse finished points), only the elements from the previous last one on go through `update()`:
 * O(new points) instead of re-sending the whole series.
 */
function pushData(entry: Entry, s: ChartSeries): { times: UTCTimestamp[]; replaced: boolean } {
  const data = s.data;
  const prev = entry.sent;
  let times: UTCTimestamp[] | null = null;
  if (
    prev !== null &&
    prev.length > 0 &&
    data.length >= prev.length &&
    data[0] === prev.first &&
    (prev.length < 2 || data[prev.length - 2] === prev.penultimate)
  ) {
    times = prev.times;
    try {
      for (const bar of toBars(s, data.slice(prev.length - 1))) {
        const last = times[times.length - 1];
        if (last !== undefined && bar.time < last) continue;
        entry.api.update(bar);
        if (bar.time !== last) times.push(bar.time);
      }
    } catch {
      times = null;
    }
  }
  const replaced = times === null;
  if (times === null) {
    const bars = toBars(s, data);
    entry.api.setData(bars);
    times = bars.map((b) => b.time);
  }
  entry.sent = {
    length: data.length,
    first: data[0],
    penultimate: data[data.length - 2],
    times,
    markers: prev?.markers ?? [],
  };
  return { times, replaced };
}

type Ohlc = { open: number; high: number; low: number; close: number };
type Legend = { time: Time | null; values: Record<string, number | Ohlc | undefined> };

const shapeKey = (s: ChartSeries) => `${s.type}:${s.pane ?? 0}`;

/** Theme- and series-dependent colours, applied at creation and again when either changes. */
function colorOptions(s: ChartSeries, T: ChartTheme): object {
  switch (s.type) {
    case "candles":
      return {
        upColor: T.up,
        downColor: T.down,
        borderUpColor: T.up,
        borderDownColor: T.down,
        wickUpColor: T.up,
        wickDownColor: T.down,
      };
    case "area":
      return { lineColor: s.color, topColor: withAlpha(s.color, 0.3), bottomColor: withAlpha(s.color, 0.02) };
    case "baseline":
      return {
        baseValue: { type: "price", price: s.baseValue ?? 0 },
        topLineColor: T.up,
        topFillColor1: withAlpha(T.up, 0.25),
        topFillColor2: withAlpha(T.up, 0.02),
        bottomLineColor: T.down,
        bottomFillColor1: withAlpha(T.down, 0.02),
        bottomFillColor2: withAlpha(T.down, 0.25),
      };
    default:
      return { color: s.color };
  }
}

const SERIES_DEFINITIONS = {
  candles: CandlestickSeries,
  histogram: HistogramSeries,
  area: AreaSeries,
  baseline: BaselineSeries,
  line: LineSeries,
} as const;

function addSeries(chart: IChartApi, s: ChartSeries, options: object): ISeriesApi<SeriesType> {
  return chart.addSeries(SERIES_DEFINITIONS[s.type] as typeof LineSeries, options, s.pane ?? 0) as ISeriesApi<SeriesType>;
}

function formatLegendValue(value: number | Ohlc | undefined, precision: number, T: ChartTheme) {
  if (value === undefined) return "—";
  if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(precision) : "—";
  const change = value.close - value.open;
  return (
    <>
      <span className="text-muted-foreground">O</span> {value.open.toFixed(precision)}{" "}
      <span className="text-muted-foreground">H</span> {value.high.toFixed(precision)}{" "}
      <span className="text-muted-foreground">L</span> {value.low.toFixed(precision)}{" "}
      <span className="text-muted-foreground">C</span>{" "}
      <span style={{ color: change > 0 ? T.up : change < 0 ? T.down : undefined }}>{value.close.toFixed(precision)}</span>
    </>
  );
}

function lastValue(s: ChartSeries): number | Ohlc | undefined {
  const last = s.data.at(-1);
  if (!last) return undefined;
  return "close" in last ? last : last.value;
}

export function TimeSeries({
  series,
  height = 260,
  className,
  precision = 3,
  fitKey,
  separators,
  lowerPaneRatio = 0.22,
  formatTick,
  formatTime,
  viewport,
}: {
  series: ChartSeries[];
  height?: number;
  /** Sizing classes (e.g. `h-64 md:h-96`); replaces `height` so it can change per breakpoint. */
  className?: string;
  precision?: number;
  /** Outside a ChartGroup: changing this value refits the visible range to the data. */
  fitKey?: string | number;
  /** Dashed vertical lines, e.g. market rollovers. */
  separators?: Separator[];
  /** Share of the height for pane 1 when a series uses it. */
  lowerPaneRatio?: number;
  /** Axis tick labels; defaults to time of day, or the date at day boundaries. */
  formatTick?: (ts: number) => string;
  /** Crosshair and legend label; defaults to date and time with seconds. */
  formatTime?: (ts: number) => string;
  /** Inside a ChartGroup: this chart's own window; defaults to all data, always following. */
  viewport?: ChartViewport;
}) {
  const group = useChartGroup();
  const T = useChartTheme();
  const formatters = useRef({ formatTick, formatTime });
  const viewportRef = useRef(viewport ?? DEFAULT_VIEWPORT);
  useEffect(() => {
    formatters.current = { formatTick, formatTime };
    viewportRef.current = viewport ?? DEFAULT_VIEWPORT;
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const memberRef = useRef<GroupMember | null>(null);
  const entriesRef = useRef(new Map<string, Entry>());
  const separatorsRef = useRef<{ primitive: SeparatorsPrimitive; host: ISeriesApi<SeriesType> } | null>(null);
  const fittedKeyRef = useRef<string | number | undefined>(undefined);
  const markerThemeRef = useRef<ChartTheme | null>(null);
  const [legend, setLegend] = useState<Legend>({ time: null, values: {} });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        attributionLogo: false,
        panes: { enableResize: true },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { style: LineStyle.Dashed },
        horzLine: { style: LineStyle.Dashed },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 }, minimumWidth: 64 },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 4,
        shiftVisibleRangeOnNewBar: false,
        tickMarkFormatter: (time: Time, tickType: number) =>
          formatters.current.formatTick?.(time as number) ?? tickLabel(time, tickType),
      },
      localization: { timeFormatter: (time: Time) => fullTime(time as number, formatters.current.formatTime) },
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
        const point = param.seriesData.get(entry.api) as ({ value?: number } & Partial<Ohlc>) | undefined;
        values[id] = point?.close !== undefined ? (point as Ohlc) : point?.value;
      }
      setLegend({ time: param.time, values });
    };
    chart.subscribeCrosshairMove(onMove);

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      entries.clear();
      separatorsRef.current = null;
      fittedKeyRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({
      layout: {
        textColor: T.text,
        fontSize: T.fontSize,
        fontFamily: T.font,
        panes: { separatorColor: T.gridStrong, separatorHoverColor: T.paneHover },
      },
      grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
      crosshair: {
        vertLine: { color: T.crosshair, labelBackgroundColor: T.labelBg },
        horzLine: { color: T.crosshair, labelBackgroundColor: T.labelBg },
      },
    });
  }, [T]);

  useEffect(() => {
    const chart = chartRef.current;
    const el = containerRef.current;
    if (!chart || !el || !group) return;
    const member: GroupMember = {
      chart,
      element: el,
      mainSeries: () => entriesRef.current.values().next().value?.api ?? null,
      viewport: () => viewportRef.current,
    };
    memberRef.current = member;
    const unregister = group.register(member);
    return () => {
      unregister();
      memberRef.current = null;
    };
  }, [group]);

  const windowSec = viewport?.windowSec;
  const following = viewport?.following;
  useEffect(() => {
    if (memberRef.current && group) group.refresh(memberRef.current);
  }, [group, windowSec, following]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const entries = entriesRef.current;
    const previousRange = chart.timeScale().getVisibleRange();
    const themeChanged = markerThemeRef.current !== T;
    markerThemeRef.current = T;

    for (const [id, entry] of entries) {
      const next = series.find((s) => s.id === id);
      if (!next || shapeKey(next) !== entry.key) {
        entry.markers?.detach();
        if (separatorsRef.current?.host === entry.api) {
          entry.api.detachPrimitive(separatorsRef.current.primitive);
          separatorsRef.current = null;
        }
        chart.removeSeries(entry.api);
        entries.delete(id);
      }
    }

    let hasData = false;
    for (const s of series) {
      const digits = s.precision ?? precision;
      const common = {
        lineWidth: s.lineWidth ?? 2,
        lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceFormat: { type: "price" as const, precision: digits, minMove: 10 ** -digits },
        lastValueVisible: !s.hideInLegend,
        priceLineVisible: false,
      };
      const options = { ...common, ...colorOptions(s, T) };
      let entry = entries.get(s.id);
      if (!entry) {
        entry = {
          key: shapeKey(s),
          api: addSeries(chart, s, options),
          markers: null,
          priceLines: [],
          priceLinesKey: "",
          sent: null,
        };
        entries.set(s.id, entry);
      } else {
        entry.api.applyOptions(options);
      }

      const previousTimes = entry.sent?.times.length ?? -1;
      const previousMarkers = entry.sent?.markers;
      const { times, replaced } = pushData(entry, s);
      hasData ||= times.length > 0;

      const priceLinesKey = JSON.stringify(s.priceLines ?? []);
      if (priceLinesKey !== entry.priceLinesKey) {
        for (const line of entry.priceLines) entry.api.removePriceLine(line);
        const api = entry.api;
        entry.priceLines = (s.priceLines ?? []).map((line) =>
          api.createPriceLine({
            price: line.price,
            color: line.color,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: line.title ?? "",
          }),
        );
        entry.priceLinesKey = priceLinesKey;
      }

      // Markers snap to bar times, so they only move when the markers or the bars change.
      const markerList = s.markers ?? [];
      const markersChanged =
        markerList.length !== previousMarkers?.length || markerList.at(-1) !== previousMarkers.at(-1);
      if (markersChanged || replaced || times.length !== previousTimes || themeChanged) {
        const markers = toMarkers(markerList, times, T);
        if (entry.markers) entry.markers.setMarkers(markers);
        else if (markers.length) entry.markers = createSeriesMarkers(entry.api, markers);
      }
      entry.sent!.markers = markerList;
    }

    const panes = chart.panes();
    if (panes.length > 1) {
      panes[0].setStretchFactor(1 - lowerPaneRatio);
      panes[1].setStretchFactor(lowerPaneRatio);
    }

    const host = entries.values().next().value?.api;
    if (host && separatorsRef.current?.host !== host) {
      const primitive = new SeparatorsPrimitive();
      host.attachPrimitive(primitive);
      separatorsRef.current = { primitive, host };
    }
    separatorsRef.current?.primitive.setLines(separators ?? [], T);

    if (memberRef.current && group) {
      group.afterData(memberRef.current, previousRange);
    } else {
      const key = fitKey ?? "default";
      if (hasData && fittedKeyRef.current !== key) {
        chart.timeScale().fitContent();
        fittedKeyRef.current = key;
      }
    }
  }, [series, precision, fitKey, separators, lowerPaneRatio, group, T]);

  const legendSeries = series.filter((s) => !s.hideInLegend);
  const hovering = legend.time !== null;
  return (
    <div className={cn("relative w-full", className)} style={className ? undefined : { height }}>
      <div ref={containerRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute left-1 right-20 top-1 z-10 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {hovering && <span className="text-muted-foreground">{fullTime(legend.time as number, formatTime)}</span>}
        {legendSeries.map((s) => {
          const value = hovering ? legend.values[s.id] : lastValue(s);
          return (
            <span key={s.id} className="flex items-center gap-1">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: s.type === "baseline" ? T.up : s.type === "candles" ? T.textStrong : s.color }}
              />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="tabular-nums text-foreground">{formatLegendValue(value, s.precision ?? precision, T)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
