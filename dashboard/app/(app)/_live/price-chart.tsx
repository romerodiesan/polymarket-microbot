"use client";

import { useMemo } from "react";
import { Signed } from "@/components/app/indicators";
import { Panel } from "@/components/app/page";
import { type Candle, candleSeries, lastIndexAtOrBefore } from "@/components/charts/candles";
import type { Separator } from "@/components/charts/separators";
import { type ChartTheme, withAlpha } from "@/components/charts/theme";
import { type ChartSeries, TimeSeries } from "@/components/charts/time-series";
import { fmtFixed, fmtPrice } from "@/lib/format";
import { ChartViewBar, useChartView } from "./controls/chart-view";
import type { TimeRange } from "./controls/use-live-controls";
import { type Side, fillsAt } from "./live-store";
import { fillMarkers } from "./model";

const close = (c: Candle) => ({ ts: c.ts, value: c.close });

export function PriceChart({
  side,
  color,
  t,
  range,
  live,
  showFills,
  breaks,
  separators,
  showBidAsk,
  marketStart,
  theme,
}: {
  side: Side;
  color: string;
  t: number;
  range: TimeRange;
  live: boolean;
  showFills: boolean;
  breaks: number[];
  separators: Separator[];
  showBidAsk: boolean;
  marketStart: number;
  theme: ChartTheme;
}) {
  const view = useChartView(`price-${side.label.toLowerCase()}`, range);
  const { interval } = view;
  const { points, fills } = side;
  const samples = points.ts.length;
  const visibleFills = showFills ? fillsAt(fills, t) : 0;

  const series = useMemo<ChartSeries[]>(() => {
    const mid = candleSeries(points.ts, points.mid, interval, breaks, points.volume);
    const out: ChartSeries[] = [
      {
        id: "price",
        label: "mid",
        type: "candles",
        color,
        data: mid.upTo(t),
        markers: fillMarkers(fills).slice(0, visibleFills),
      },
    ];
    if (showBidAsk) {
      const bid = candleSeries(points.ts, points.bid, interval, breaks).pointsUpTo(t, "close", close);
      const ask = candleSeries(points.ts, points.ask, interval, breaks).pointsUpTo(t, "close", close);
      out.push(
        { id: "bid", label: "bid", type: "line", color: theme.bid, lineWidth: 1, dashed: true, data: bid },
        { id: "ask", label: "ask", type: "line", color: theme.ask, lineWidth: 1, dashed: true, data: ask },
      );
    }
    if (mid.hasVolume) {
      const up = withAlpha(theme.up, 0.45);
      const down = withAlpha(theme.down, 0.45);
      out.push({
        id: "volume",
        label: "volumen",
        type: "histogram",
        pane: 1,
        precision: 0,
        color: theme.text,
        data: mid.pointsUpTo(t, `volume:${up}:${down}`, (c) => ({
          ts: c.ts,
          value: c.volume,
          color: c.close >= c.open ? up : down,
        })),
      });
    }
    return out;
    // `samples`: the arrays grow in place, so their length is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, samples, fills, visibleFills, t, interval, breaks, showBidAsk, color, theme]);

  const end = lastIndexAtOrBefore(points.ts, t);
  const openIndex = Math.max(0, lastIndexAtOrBefore(points.ts, marketStart - 1e-9) + 1);
  const last = end >= 0 ? end : null;
  const open = last !== null && openIndex <= last ? openIndex : null;
  const change = last !== null && open !== null ? points.mid[last] - points.mid[open] : 0;
  const changePct = open !== null && points.mid[open] > 0 ? (change / points.mid[open]) * 100 : null;

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="flex items-center gap-2">
            <span className="size-2.5 rounded-full" style={{ background: color }} />
            {side.label}
          </span>
          {last !== null && (
            <>
              <span className="font-mono text-lg font-semibold tabular-nums">{fmtPrice(points.mid[last])}</span>
              <span className="font-mono text-xs font-normal tabular-nums">
                <Signed value={change} format={(n) => `${n > 0 ? "+" : ""}${fmtFixed(n, 3)}`} epsilon={5e-4} />
                {changePct !== null && (
                  <span className="text-muted-foreground"> ({change >= 0 ? "+" : ""}{changePct.toFixed(1)}%)</span>
                )}
              </span>
            </>
          )}
        </span>
      }
      description={
        last !== null && (
          <span className="flex flex-wrap gap-x-3 font-mono tabular-nums">
            <span>bid {fmtPrice(points.bid[last])}</span>
            <span>ask {fmtPrice(points.ask[last])}</span>
            <span>spread {fmtPrice(points.spread[last])}</span>
            <span>imb {points.imbalance[last].toFixed(2)}</span>
          </span>
        )
      }
    >
      <ChartViewBar view={view} live={live} />
      <TimeSeries
        className="h-[280px] md:h-[360px] 2xl:h-[420px]"
        series={series}
        separators={separators}
        viewport={view.viewport}
      />
    </Panel>
  );
}
