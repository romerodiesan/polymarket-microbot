"use client";

import { memo, useMemo } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useChartTheme } from "./theme";

export type XYSeries = {
  id: string;
  label: string;
  color: string;
  points: { x: number; y: number }[];
  dashed?: boolean;
  /** Draw as steps (e.g. cumulative depth) instead of straight segments. */
  step?: boolean;
  dots?: boolean;
};

/**
 * Several lines over a shared numeric x axis (calibration curves, cumulative PnL, depth).
 * Memoized: pass stable `series` and formatter references to skip re-rendering the chart.
 */
export const XYLines = memo(function XYLines({
  series,
  height = 240,
  xDomain,
  yDomain,
  formatX = (v) => String(v),
  formatY = (v) => String(v),
  xLabel,
  zeroLine = false,
}: {
  series: XYSeries[];
  height?: number;
  xDomain?: [number | "auto", number | "auto"];
  yDomain?: [number | "auto", number | "auto"];
  formatX?: (v: number) => string;
  formatY?: (v: number) => string;
  xLabel?: (x: number) => React.ReactNode;
  zeroLine?: boolean;
}) {
  const theme = useChartTheme();
  const tick = { fill: theme.text, fontSize: theme.fontSize, fontFamily: theme.font };
  const config = useMemo(
    () => Object.fromEntries(series.map((s) => [s.id, { label: s.label, color: s.color }])) satisfies ChartConfig,
    [series],
  );
  const data = useMemo(() => {
    // One row per distinct x with a column per series, as recharts expects.
    const byX = new Map<number, Record<string, number>>();
    for (const s of series) {
      for (const p of s.points) {
        let row = byX.get(p.x);
        if (!row) {
          row = { x: p.x };
          byX.set(p.x, row);
        }
        row[s.id] = p.y;
      }
    }
    return [...byX.values()].sort((a, b) => a.x - b.x);
  }, [series]);

  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
        <CartesianGrid stroke={theme.grid} />
        <XAxis
          dataKey="x"
          type="number"
          domain={xDomain ?? ["dataMin", "dataMax"]}
          tickLine={false}
          axisLine={false}
          tick={tick}
          tickFormatter={formatX}
          minTickGap={24}
        />
        <YAxis
          type="number"
          domain={yDomain ?? ["auto", "auto"]}
          tickLine={false}
          axisLine={false}
          tick={tick}
          tickFormatter={formatY}
          width={56}
        />
        {zeroLine && <ReferenceLine y={0} stroke={theme.zeroLine} strokeWidth={1.5} />}
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                const x = (payload?.[0]?.payload as { x?: number } | undefined)?.x;
                return x === undefined ? null : (xLabel?.(x) ?? formatX(x));
              }}
              formatter={(value, name) => (
                <div className="flex w-full items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: `var(--color-${name})` }} />
                    {config[name as string]?.label ?? name}
                  </span>
                  <span className="font-mono font-medium tabular-nums text-foreground">{formatY(Number(value))}</span>
                </div>
              )}
            />
          }
        />
        {series.map((s) => (
          <Line
            key={s.id}
            dataKey={s.id}
            type={s.step ? "stepAfter" : "linear"}
            stroke={`var(--color-${s.id})`}
            strokeWidth={s.dashed ? 1 : 2}
            strokeDasharray={s.dashed ? "4 4" : undefined}
            dot={s.dots ? { r: 2.5 } : false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
});
