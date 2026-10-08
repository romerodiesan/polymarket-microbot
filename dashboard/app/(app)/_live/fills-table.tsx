"use client";

import { type Column, DataTable } from "@/components/app/data-table";
import { Signed, ToneBadge, TokenBadge } from "@/components/app/indicators";
import type { BotData, Fill } from "@/lib/data";
import { fmtFixed, fmtPrice, fmtTime, fmtUsd } from "@/lib/format";

const REASONS: Record<string, string> = {
  entry: "Entrada",
  take_profit: "Take profit",
  stop_loss: "Stop loss",
  max_hold: "Tiempo máximo",
  signal_reversal: "Señal invertida",
  signal_faded: "Señal agotada",
  rollover: "Cambio de mercado",
};

function fillColumns(tokens: BotData["tokens"]): Column<Fill>[] {
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

export function FillsTable({ fills, tokens }: { fills: Fill[]; tokens: BotData["tokens"] }) {
  return (
    <DataTable
      columns={fillColumns(tokens)}
      rows={fills.slice().reverse()}
      rowKey={(f, i) => `${f.order_id}-${f.ts}-${i}`}
      maxHeight={380}
      empty="El bot aún no ha ejecutado operaciones."
    />
  );
}
