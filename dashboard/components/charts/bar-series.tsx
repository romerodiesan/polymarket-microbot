"use client";

import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";

export type BarDatum = { x: string | number; value: number };

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
}) {
  const config = { value: { label, color } } satisfies ChartConfig;
  const rows = orientation === "rows";
  const tooltip = (
    <ChartTooltip
      cursor={{ fill: "rgba(255,255,255,0.06)" }}
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
        margin={{ top: 8, right: 12, bottom: 0, left: rows ? 0 : -12 }}
      >
        <CartesianGrid vertical={rows} horizontal={!rows} strokeDasharray="3 3" />
        {rows ? (
          <>
            <XAxis type="number" tickLine={false} axisLine={false} fontSize={11} tickFormatter={(v: number) => formatValue(v)} />
            <YAxis
              type="category"
              dataKey="x"
              tickLine={false}
              axisLine={false}
              width={categoryWidth}
              fontSize={11}
              tickFormatter={formatX}
              interval={0}
            />
            <ReferenceLine x={0} stroke="rgba(255,255,255,0.25)" />
          </>
        ) : (
          <>
            <XAxis dataKey="x" tickLine={false} axisLine={false} fontSize={11} tickFormatter={formatX} minTickGap={40} />
            <YAxis tickLine={false} axisLine={false} fontSize={11} allowDecimals={false} />
          </>
        )}
        {tooltip}
        <Bar dataKey="value" fill="var(--color-value)" radius={rows ? 3 : [3, 3, 0, 0]} isAnimationActive={false}>
          {colorOf && data.map((row, i) => <Cell key={i} fill={colorOf(row)} />)}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
