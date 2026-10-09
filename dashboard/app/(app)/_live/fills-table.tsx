"use client";

import { type Column, DataTable } from "@/components/app/data-table";
import { Signed, ToneBadge, TokenBadge } from "@/components/app/indicators";
import type { BotMeta } from "@/lib/data";
import { fmtFixed, fmtInt, fmtPrice, fmtTime, fmtUsd } from "@/lib/format";
import type { Fill } from "./live-store";

const REASONS: Record<string, string> = {
  entry: "Entrada",
  take_profit: "Take profit",
  stop_loss: "Stop loss",
  max_hold: "Tiempo máximo",
  signal_reversal: "Señal invertida",
  signal_faded: "Señal agotada",
  rollover: "Cambio de mercado",
};

function fillColumns(tokens: BotMeta["tokens"]): Column<Fill>[] {
  const label = (id: string) => (id === tokens.yes ? "YES" : id === tokens.no ? "NO" : id.slice(0, 8));
  return [
    { key: "ts", header: "Hora", cell: (f) => <span className="font-mono tabular-nums">{fmtTime(f.ts)}</span> },
    { key: "token", header: "Token", cell: (f) => <TokenBadge label={f.outcome ?? label(f.token_id)} /> },
    {
      key: "side",
      header: "Lado",
      cell: (f) => <ToneBadge tone={f.side === "BUY" ? "sky" : "amber"}>{f.side === "BUY" ? "Compra" : "Venta"}</ToneBadge>,
    },
    { key: "size", header: "Tamaño", numeric: true, cell: (f) => fmtFixed(f.size, 2) },
    { key: "price", header: "Precio", numeric: true, cell: (f) => fmtPrice(f.price) },
    { key: "notional", header: "Importe", numeric: true, hideOnMobile: true, cell: (f) => fmtUsd(f.size * f.price) },
    { key: "fee", header: "Fee", numeric: true, hideOnMobile: true, cell: (f) => fmtFixed(f.fee, 4) },
    {
      key: "pnl",
      header: "PnL",
      numeric: true,
      hint: "PnL realizado al cerrar contra el precio medio de entrada",
      cell: (f) =>
        f.side === "SELL" ? (
          <Signed value={f.pnl} format={(n) => fmtFixed(n, 4)} />
        ) : (
          <span className="text-muted-foreground/50">—</span>
        ),
    },
    {
      key: "reason",
      header: "Motivo",
      cell: (f) => <span className="text-muted-foreground">{REASONS[f.reason.split(" ")[0]] ?? (f.reason || "—")}</span>,
    },
    { key: "mode", header: "Modo", hideOnMobile: true, cell: (f) => <ToneBadge className="uppercase">{f.mode}</ToneBadge> },
  ];
}

const MAX_ROWS = 200;

/** The latest of the first `count` fills (those visible at the playback time), newest first. */
export function FillsTable({ fills, count, tokens }: { fills: Fill[]; count: number; tokens: BotMeta["tokens"] }) {
  const rows = fills.slice(Math.max(0, count - MAX_ROWS), count).reverse();
  return (
    <>
      <DataTable
        columns={fillColumns(tokens)}
        rows={rows}
        rowKey={(f) => `${f.order_id}-${f.ts}-${f.side}`}
        maxHeight={380}
        empty="El bot aún no ha ejecutado operaciones."
      />
      {count > MAX_ROWS && (
        <p className="mt-2 text-xs text-muted-foreground">
          Últimos {fmtInt(MAX_ROWS)} de {fmtInt(count)} fills.
        </p>
      )}
    </>
  );
}
