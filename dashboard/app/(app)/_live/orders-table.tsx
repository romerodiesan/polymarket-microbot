"use client";

import { memo, useMemo } from "react";
import { lastIndexAtOrBefore } from "@/components/charts/candles";
import { type Column, DataTable } from "@/components/app/data-table";
import { type Tone, ToneBadge, TokenBadge } from "@/components/app/indicators";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BotMeta, OrderRow } from "@/lib/data";
import { fmtFixed, fmtInt, fmtPrice, fmtTime } from "@/lib/format";

const MAX_ROWS = 200;

const STATUS: Record<string, { label: string; tone: Tone }> = {
  filled: { label: "Ejecutada", tone: "green" },
  partial: { label: "Parcial", tone: "sky" },
  rejected: { label: "Rechazada", tone: "red" },
  expired: { label: "Expirada", tone: "amber" },
  cancelled: { label: "Cancelada", tone: "neutral" },
};

const REJECTS: Record<string, string> = {
  no_liquidity_within_limit: "sin liquidez dentro del límite",
  insufficient_cash: "efectivo insuficiente",
  no_position: "sin posición",
  no_match: "sin cruce",
};

const dash = <span className="text-muted-foreground/50">—</span>;
const optional = (n: number | null, format: (v: number) => string) => (n == null ? dash : format(n));

export type ExecutionStats = {
  orders: number;
  fillRate: number | null;
  rejectRate: number | null;
  partialRate: number | null;
  /** Mean over orders with any fill, in price units (positive = paid more than the touch). */
  slippageVsTouch: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
};

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const submitTimes = new WeakMap<OrderRow[], number[]>();

/** Number of `orders` (in submission order) submitted at or before `t`: a binary search. */
export function ordersAt(orders: OrderRow[], t: number): number {
  let times = submitTimes.get(orders);
  if (!times) {
    times = orders.map((o) => o.submit_ts);
    submitTimes.set(orders, times);
  }
  return lastIndexAtOrBefore(times, t) + 1;
}

let lastStats: { orders: OrderRow[]; count: number; stats: ExecutionStats } | null = null;

/** Stats of the first `count` orders; recomputed only when the orders or the count change. */
export function executionStats(orders: OrderRow[], count: number): ExecutionStats {
  if (lastStats?.orders !== orders || lastStats.count !== count) {
    lastStats = { orders, count, stats: computeStats(orders.slice(0, count)) };
  }
  return lastStats.stats;
}

function computeStats(orders: OrderRow[]): ExecutionStats {
  const done = orders.filter((o) => o.status);
  const filled = done.filter((o) => (o.filled_size ?? 0) > 0);
  const slippage = filled.map((o) => o.slippage_vs_touch).filter((v): v is number => v != null);
  const latency = done
    .map((o) => o.latency_ms)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const rate = (k: number) => (done.length ? k / done.length : null);
  return {
    orders: done.length,
    fillRate: rate(filled.length),
    rejectRate: rate(done.filter((o) => o.status === "rejected").length),
    partialRate: rate(done.filter((o) => o.status === "partial").length),
    slippageVsTouch: slippage.length ? slippage.reduce((s, v) => s + v, 0) / slippage.length : null,
    latencyP50: quantile(latency, 0.5),
    latencyP95: quantile(latency, 0.95),
  };
}

function columns(tokens: BotMeta["tokens"]): Column<OrderRow>[] {
  const label = (id: string) => (id === tokens.yes ? "YES" : id === tokens.no ? "NO" : id.slice(0, 8));
  return [
    { key: "ts", header: "Hora", cell: (o) => <span className="font-mono tabular-nums">{fmtTime(o.submit_ts)}</span> },
    { key: "token", header: "Token", cell: (o) => <TokenBadge label={o.outcome ?? label(o.token_id)} /> },
    {
      key: "side",
      header: "Lado",
      cell: (o) => <ToneBadge tone={o.side === "BUY" ? "sky" : "amber"}>{o.side === "BUY" ? "Compra" : "Venta"}</ToneBadge>,
    },
    { key: "reason", header: "Motivo", hideOnMobile: true, cell: (o) => <span className="text-muted-foreground">{o.reason ?? "—"}</span> },
    {
      key: "status",
      header: "Estado",
      cell: (o) => {
        const s = STATUS[o.status ?? ""] ?? { label: o.status ?? "en curso", tone: "neutral" as Tone };
        return (
          <span className="flex items-center gap-1.5">
            <ToneBadge tone={s.tone}>{s.label}</ToneBadge>
            {o.reject_reason && <span className="text-xs text-muted-foreground">{REJECTS[o.reject_reason] ?? o.reject_reason}</span>}
          </span>
        );
      },
    },
    {
      key: "size",
      header: "Ejecutado / pedido",
      numeric: true,
      cell: (o) => `${o.filled_size == null ? "—" : fmtFixed(o.filled_size, 2)} / ${o.requested_size == null ? "—" : fmtFixed(o.requested_size, 2)}`,
    },
    { key: "limit", header: "Límite", numeric: true, hideOnMobile: true, cell: (o) => optional(o.limit_price, fmtPrice) },
    { key: "avg", header: "Precio medio", numeric: true, cell: (o) => (o.filled_size ? optional(o.avg_price, (v) => fmtFixed(v, 4)) : dash) },
    {
      key: "slip",
      header: "Slippage touch",
      numeric: true,
      hint: "Precio medio frente al mejor precio al decidir; positivo = peor que el touch (incluye la comisión)",
      cell: (o) => (o.filled_size ? optional(o.slippage_vs_touch, (v) => fmtFixed(v, 4)) : dash),
    },
    { key: "latency", header: "Latencia", numeric: true, hideOnMobile: true, cell: (o) => optional(o.latency_ms, (v) => `${fmtInt(v)} ms`) },
    {
      key: "fee",
      header: "Comisión",
      numeric: true,
      hideOnMobile: true,
      cell: (o) =>
        o.fee == null ? dash : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help">{fmtFixed(o.fee, 4)}</span>
            </TooltipTrigger>
            <TooltipContent>
              Tasa {o.fee_rate ?? "—"} · {o.fee_source ?? "fuente desconocida"}
            </TooltipContent>
          </Tooltip>
        ),
    },
  ];
}

/** The first `count` orders, newest first. */
export const OrdersTable = memo(function OrdersTable({ orders, count, tokens }: {
  orders: OrderRow[];
  count: number;
  tokens: BotMeta["tokens"];
}) {
  const rows = useMemo(() => orders.slice(Math.max(0, count - MAX_ROWS), count).reverse(), [orders, count]);
  const cols = useMemo(() => columns(tokens), [tokens]);
  return (
    <>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(o) => o.order_id}
        maxHeight={380}
        empty="El bot aún no ha enviado órdenes (o los datos son anteriores al registro de órdenes)."
      />
      {count > MAX_ROWS && (
        <p className="mt-2 text-xs text-muted-foreground">
          Últimas {fmtInt(MAX_ROWS)} de {fmtInt(count)} órdenes.
        </p>
      )}
    </>
  );
});
