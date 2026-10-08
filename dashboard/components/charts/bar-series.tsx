"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useChartTheme } from "./theme";

export type BarDatum = { x: string | number; value: number };

function niceStep(raw: number) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/** Round ticks covering the data and zero; with value labels, room left of negative bars for theirs. */
function valueTicks(values: number[], padNegative: boolean) {
  let min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  if (max === min) return undefined;
  if (padNegative && min < 0) min -= (max - min) * 0.25;
  const step = niceStep((max - min) / 4);
  const ticks: number[] = [];
  for (let t = Math.floor(min / step) * step; t <= max + step * 0.999; t += step) ticks.push(Number(t.toPrecision(12)));
  return ticks;
}

export function BarSeries<T extends BarDatum>({
  data,
  label,
  color,
  colorOf,
  orientation = "columns",
  height = 240,
  formatX = String,
  formatLabel,
  formatValue = (v) => v.toLocaleString("en-US"),
  categoryWidth = 140,
  showValues = false,
}: {
  data: T[];
  label: string;
  color: string;
  /** Per-bar colour, e.g. by sign. */
  colorOf?: (row: T) => string;
  /** `columns`: vertical bars over x. `rows`: horizontal bars, one category per row. */
  orientation?: "columns" | "rows";
  height?: number;
  formatX?: (x: T["x"]) => string;
  formatLabel?: (row: T) => React.ReactNode;
  formatValue?: (value: number) => string;
  categoryWidth?: number;
  /** Print each bar's value at its end. */
  showValues?: boolean;
}) {
  const chartTheme = useChartTheme();
  const tick = { fill: chartTheme.text, fontSize: chartTheme.fontSize, fontFamily: chartTheme.font };
  const config = { value: { label, color } } satisfies ChartConfig;
  const rows = orientation === "rows";
  const ticks = rows ? valueTicks(data.map((d) => d.value), showValues) : undefined;
  const tooltip = (
    <ChartTooltip
      cursor={{ fill: chartTheme.cursorFill }}
      content={
        <ChartTooltipContent
          labelFormatter={(_, payload) => {
            const row = payload?.[0]?.payload as T | undefined;
            return row ? (formatLabel?.(row) ?? formatX(row.x)) : null;
          }}
          formatter={(value, _name, item) => (
            <div className="flex w-full items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span
                  className="h-2.5 w-2.5 rounded-[2px]"
                  style={{ background: colorOf ? colorOf(item.payload as T) : color }}
                />
                {label}
              </span>
              <span className="font-mono font-medium tabular-nums text-foreground">{formatValue(Number(value))}</span>
            </div>
          )}
        />
      }
    />
  );

  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
      <BarChart
        accessibilityLayer
        data={data}
        layout={rows ? "vertical" : "horizontal"}
        margin={{
          top: 8,
          right: showValues && rows ? 48 : 12,
          bottom: 0,
          left: rows ? 0 : -12,
        }}
      >
        <CartesianGrid vertical={rows} horizontal={!rows} stroke={chartTheme.grid} />
        {rows ? (
          <>
            <XAxis
              type="number"
              tickLine={false}
              axisLine={false}
              tick={tick}
              tickFormatter={(v: number) => formatValue(v)}
              ticks={ticks}
              domain={ticks ? [ticks[0], ticks[ticks.length - 1]] : undefined}
            />
            <YAxis
              type="category"
              dataKey="x"
              tickLine={false}
              axisLine={false}
              width={categoryWidth}
              tick={tick}
              tickFormatter={formatX}
              interval={0}
            />
            <ReferenceLine x={0} stroke={chartTheme.zeroLine} strokeWidth={1.5} />
          </>
        ) : (
          <>
            <XAxis dataKey="x" tickLine={false} axisLine={false} tick={tick} tickFormatter={formatX} minTickGap={40} />
            <YAxis tickLine={false} axisLine={false} tick={tick} allowDecimals={false} />
          </>
        )}
        {tooltip}
        <Bar dataKey="value" fill="var(--color-value)" radius={rows ? 3 : [3, 3, 0, 0]} isAnimationActive={false}>
          {colorOf && data.map((row, i) => <Cell key={i} fill={colorOf(row)} />)}
          {showValues && rows && (
            <LabelList
              dataKey="value"
              content={(props) => {
                const x = Number(props.x);
                const width = Number(props.width);
                const value = Number(props.value);
                const y = Number(props.y) + Number(props.height) / 2;
                const negative = value < 0;
                return (
                  <text
                    x={negative ? Math.min(x, x + width) - 4 : Math.max(x, x + width) + 4}
                    y={y}
                    dominantBaseline="central"
                    textAnchor={negative ? "end" : "start"}
                    {...tick}
                    fill={chartTheme.textStrong}
                  >
                    {formatValue(value)}
                  </text>
                );
              }}
            />
          )}
          {showValues && !rows && (
            <LabelList
              dataKey="value"
              position="top"
              formatter={(v: unknown) => formatValue(Number(v))}
              style={{ ...tick, fill: chartTheme.textStrong }}
            />
          )}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
