"use client";

import { useMemo } from "react";
import { Signed } from "@/components/app/indicators";
import { Panel } from "@/components/app/page";
import { toCandles } from "@/components/charts/candles";
import type { Separator } from "@/components/charts/separators";
import { type ChartTheme, withAlpha } from "@/components/charts/theme";
import { type ChartSeries, TimeSeries } from "@/components/charts/time-series";
import type { Fill } from "@/lib/data";
import { fmtFixed, fmtPrice } from "@/lib/format";
import { ChartViewBar, useChartView } from "./controls/chart-view";
import type { TimeRange } from "./controls/use-live-controls";
import { type Outcome, bucketed, lastIndexAtOrBefore, upTo } from "./model";

export function PriceChart({
  side,
  t,
  range,
  live,
  fills,
  breaks,
  separators,
  showBidAsk,
  marketStart,
  theme,
}: {
  side: Outcome;
  t: number;
  range: TimeRange;
  live: boolean;
  fills: Fill[];
  breaks: number[];
  separators: Separator[];
  showBidAsk: boolean;
  marketStart: number;
  theme: ChartTheme;
}) {
  const view = useChartView(`price-${side.label.toLowerCase()}`, range);
  const { interval } = view;
  const points = useMemo(() => upTo(side.points, t), [side.points, t]);
  const series = useMemo<ChartSeries[]>(() => {
    const candles = toCandles(points.map((p) => ({ ts: p.ts, value: p.mid, volume: p.volume })), interval, breaks);
    const out: ChartSeries[] = [
      {
        id: "price",
        label: "mid",
        type: "candles",
        color: side.color,
        data: candles,
        markers: fills.map((f) => ({
          ts: f.ts,
          price: f.price,
          kind: f.side === "BUY" ? "buy" : "sell",
          text: `${f.side === "BUY" ? "C" : "V"} ${fmtFixed(f.size, 1)}`,
        })),
      },
    ];
    if (showBidAsk) {
      out.push(
        { id: "bid", label: "bid", type: "line", color: theme.bid, lineWidth: 1, dashed: true, data: bucketed(points, (p) => p.bid, interval, breaks) },
        { id: "ask", label: "ask", type: "line", color: theme.ask, lineWidth: 1, dashed: true, data: bucketed(points, (p) => p.ask, interval, breaks) },
      );
    }
    if (candles.some((c) => c.volume > 0)) {
      out.push({
        id: "volume",
        label: "volumen",
        type: "histogram",
        pane: 1,
        precision: 0,
        color: theme.text,
        data: candles.map((c) => ({
          ts: c.ts,
          value: c.volume,
          color: withAlpha(c.close >= c.open ? theme.up : theme.down, 0.45),
        })),
      });
    }
    return out;
  }, [points, fills, interval, breaks, showBidAsk, side.color, theme]);

  const last = points.at(-1);
  const open = points[Math.max(0, lastIndexAtOrBefore(points, marketStart - 1e-9) + 1)];
  const change = last && open ? last.mid - open.mid : 0;
  const changePct = open && open.mid > 0 ? (change / open.mid) * 100 : null;

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="flex items-center gap-2">
            <span className="size-2.5 rounded-full" style={{ background: side.color }} />
            {side.label}
          </span>
          {last && (
            <>
              <span className="font-mono text-lg font-semibold tabular-nums">{fmtPrice(last.mid)}</span>
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
        last && (
          <span className="flex flex-wrap gap-x-3 font-mono tabular-nums">
            <span>bid {fmtPrice(last.bid)}</span>
            <span>ask {fmtPrice(last.ask)}</span>
            <span>spread {fmtPrice(last.spread)}</span>
            <span>imb {last.imbalance.toFixed(2)}</span>
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
