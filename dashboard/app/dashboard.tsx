"use client";

import { useEffect, useMemo, useState } from "react";
import { TimeSeries } from "@/components/charts/time-series";
import {
  Badge,
  Card,
  type Column,
  DataTable,
  Kpi,
  Notice,
  Page,
  PageHeader,
  Signed,
  TokenBadge,
  fmtFixed,
  fmtPrice,
  fmtTime,
  fmtUsd,
} from "@/components/ui";
import type { BotData, FeaturePoint, Fill } from "@/lib/data";

const POLL_MS = 3000;
const TICK_MS = 100;
const SPEEDS = [1, 10, 60, 300];
const WINDOWS = [
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
  { label: "Todo", seconds: Infinity },
];

function lastIndexAtOrBefore(points: { ts: number }[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].ts <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function sliceWindow<T extends { ts: number }>(points: T[], from: number, to: number): T[] {
  const end = lastIndexAtOrBefore(points, to);
  if (end < 0) return [];
  const start = Number.isFinite(from) ? lastIndexAtOrBefore(points, from) + 1 : 0;
  return points.slice(start, end + 1);
}

function portfolioAt(data: BotData, t: number) {
  let cash = data.config.startingCash;
  const positions: Record<string, number> = {};
  for (const f of data.fills) {
    if (f.ts > t) break;
    const signed = f.side === "BUY" ? f.size : -f.size;
    cash -= signed * f.price + f.fee;
    positions[f.token_id] = (positions[f.token_id] ?? 0) + signed;
  }
  let equity = cash;
  for (const [token, pos] of Object.entries(positions)) {
    const points = data.features[token] ?? [];
    const i = lastIndexAtOrBefore(points, t);
    if (i >= 0) equity += pos * points[i].mid;
  }
  return { cash, positions, equity, pnl: equity - data.config.startingCash };
}

function equityCurve(data: BotData) {
  const tokens = Object.keys(data.features);
  const timeline = tokens
    .flatMap((token) => data.features[token].map((p) => ({ ts: p.ts, token, mid: p.mid })))
    .sort((a, b) => a.ts - b.ts);
  const lastMid: Record<string, number> = {};
  const positions: Record<string, number> = {};
  let cash = data.config.startingCash;
  let fillIdx = 0;
  const out: { ts: number; equity: number }[] = [];
  const step = Math.max(1, Math.floor(timeline.length / 1500));
  timeline.forEach((p, i) => {
    lastMid[p.token] = p.mid;
    while (fillIdx < data.fills.length && data.fills[fillIdx].ts <= p.ts) {
      const f = data.fills[fillIdx++];
      const signed = f.side === "BUY" ? f.size : -f.size;
      cash -= signed * f.price + f.fee;
      positions[f.token_id] = (positions[f.token_id] ?? 0) + signed;
    }
    if (i % step === 0 || i === timeline.length - 1) {
      let equity = cash;
      for (const [token, pos] of Object.entries(positions)) equity += pos * (lastMid[token] ?? 0);
      out.push({ ts: p.ts, equity });
    }
  });
  return out;
}

export default function Dashboard() {
  const [data, setData] = useState<BotData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const [cursor, setCursor] = useState(0);
  const [windowSec, setWindowSec] = useState(900);
  const [now, setNow] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/data", { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error ?? res.statusText);
        setData(json);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
      if (!cancelled) setNow(Date.now() / 1000);
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const range = useMemo(() => {
    if (!data) return null;
    const all = Object.values(data.features).flat();
    if (!all.length) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const p of all) {
      if (p.ts < min) min = p.ts;
      if (p.ts > max) max = p.ts;
    }
    // A fill can land just after the last feature sample; keep it visible in live mode.
    const lastFill = data.fills.at(-1);
    if (lastFill && lastFill.ts > max) max = lastFill.ts;
    return { min, max };
  }, [data]);

  const t = live ? (range?.max ?? 0) : Math.min(Math.max(cursor, range?.min ?? 0), range?.max ?? 0);

  useEffect(() => {
    if (live || !playing || !range) return;
    const id = setInterval(() => {
      setCursor((c) => {
        const next = c + (TICK_MS / 1000) * speed;
        if (next >= range.max) {
          setPlaying(false);
          return range.max;
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [live, playing, speed, range]);

  const curve = useMemo(() => (data ? equityCurve(data) : []), [data]);

  if (error && !data) {
    return <Shell><Notice tone="error">Error leyendo datos: {error}</Notice></Shell>;
  }
  if (!data) return <Shell><Notice>Cargando…</Notice></Shell>;
  if (!range) {
    return (
      <Shell data={data}>
        <Notice>
          Aún no hay datos. Arranca el bot con <code>microbot</code>; exporta Parquet cada pocos
          segundos a <code>data/parquet/</code>.
        </Notice>
      </Shell>
    );
  }

  const from = t - windowSec;
  const portfolio = portfolioAt(data, t);
  const visibleFills = data.fills.filter((f) => f.ts <= t);
  const lagSeconds = data.exportedAt && now ? now - data.exportedAt : Infinity;
  const tokenRows = [
    { id: data.tokens.yes, label: "YES", color: "#22c55e" },
    { id: data.tokens.no, label: "NO", color: "#ef4444" },
  ];
  // Live: keep the user's zoom between polls. Replay: follow the cursor.
  const fitKey = live ? `live-${windowSec}` : `replay-${windowSec}-${Math.floor(t)}`;
  const threshold = data.config.signalThreshold;

  const startReplay = () => {
    setLive(false);
    setCursor(range.min);
    setPlaying(true);
  };

  return (
    <Shell data={data} lagSeconds={lagSeconds}>
      <section className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[.03] p-3 text-sm">
        <button
          onClick={() => {
            setLive(true);
            setPlaying(false);
          }}
          className={`rounded-md px-3 py-1.5 font-medium ${live ? "bg-emerald-500 text-black" : "bg-white/10 hover:bg-white/20"}`}
        >
          ● En vivo
        </button>
        <button onClick={startReplay} className="rounded-md bg-white/10 px-3 py-1.5 hover:bg-white/20">
          ⏮ Reproducir desde el inicio
        </button>
        {!live && (
          <button
            onClick={() => setPlaying((p) => !p)}
            className="rounded-md bg-sky-500 px-3 py-1.5 font-medium text-black"
          >
            {playing ? "⏸ Pausa" : "▶ Play"}
          </button>
        )}
        <label className="flex items-center gap-2">
          Velocidad
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            className="rounded-md bg-white/10 px-2 py-1"
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s} className="bg-zinc-900">{s}x</option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1">
          Ventana
          {WINDOWS.map((w) => (
            <button
              key={w.label}
              onClick={() => setWindowSec(w.seconds)}
              className={`rounded px-2 py-1 ${windowSec === w.seconds ? "bg-white/25" : "bg-white/5 hover:bg-white/15"}`}
            >
              {w.label}
            </button>
          ))}
        </div>
        <input
          type="range"
          min={range.min}
          max={range.max}
          step="any"
          value={t}
          onChange={(e) => {
            setLive(false);
            setPlaying(false);
            setCursor(Number(e.target.value));
          }}
          className="min-w-48 flex-1 accent-sky-500"
        />
        <span className="font-mono tabular-nums text-zinc-300">{fmtTime(t)}</span>
      </section>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Equity" value={fmtUsd(portfolio.equity)} />
        <Kpi
          label="PnL"
          value={fmtUsd(portfolio.pnl)}
          tone={portfolio.pnl > 0 ? "up" : portfolio.pnl < 0 ? "down" : undefined}
        />
        <Kpi label="Cash" value={fmtUsd(portfolio.cash)} />
        <Kpi label="Posición YES" value={(portfolio.positions[data.tokens.yes] ?? 0).toFixed(2)} />
        <Kpi label="Posición NO" value={(portfolio.positions[data.tokens.no] ?? 0).toFixed(2)} />
        <Kpi label="Fills" value={String(visibleFills.length)} />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        {tokenRows.map((tok) => (
          <PriceChart
            key={tok.label}
            label={tok.label}
            color={tok.color}
            points={sliceWindow(data.features[tok.id] ?? [], from, t)}
            fills={visibleFills.filter((f) => f.token_id === tok.id && f.ts > from)}
            fitKey={fitKey}
          />
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card title="Score de la señal">
          <TimeSeries
            height={240}
            precision={2}
            fitKey={fitKey}
            series={tokenRows.map((tok, i) => ({
              id: `score-${tok.label}`,
              label: `score ${tok.label}`,
              type: "line",
              color: tok.color,
              lineWidth: 2,
              data: sliceWindow(data.features[tok.id] ?? [], from, t).map((p) => ({ ts: p.ts, value: p.score })),
              priceLines:
                i === 0
                  ? [
                      { price: threshold, color: "#38bdf8", title: "umbral" },
                      { price: 0, color: "#52525b" },
                      { price: -threshold, color: "#38bdf8", title: "umbral" },
                    ]
                  : undefined,
            }))}
          />
        </Card>
        <Card title="Equity">
          <TimeSeries
            height={240}
            precision={2}
            fitKey={fitKey}
            series={[
              {
                id: "equity",
                label: "equity",
                type: "baseline",
                color: "#a78bfa",
                baseValue: data.config.startingCash,
                data: sliceWindow(curve, from, t).map((p) => ({ ts: p.ts, value: p.equity })),
              },
            ]}
          />
        </Card>
      </section>

      <Card title={`Fills (${visibleFills.length})`}>
        <DataTable
          columns={fillColumns(data.tokens)}
          rows={visibleFills.slice().reverse()}
          rowKey={(f, i) => `${f.order_id}-${f.ts}-${i}`}
          maxHeight={360}
          empty="El bot aún no ha ejecutado operaciones."
        />
      </Card>
    </Shell>
  );
}

function fillColumns(tokens: BotData["tokens"]): Column<Fill>[] {
  const label = (id: string) => (id === tokens.yes ? "YES" : id === tokens.no ? "NO" : id.slice(0, 8));
  return [
    { key: "ts", header: "Hora", cell: (f) => <span className="font-mono tabular-nums text-zinc-300">{fmtTime(f.ts)}</span> },
    { key: "token", header: "Token", cell: (f) => <TokenBadge label={label(f.token_id)} /> },
    {
      key: "side",
      header: "Lado",
      cell: (f) => <Badge tone={f.side === "BUY" ? "sky" : "amber"}>{f.side === "BUY" ? "Compra" : "Venta"}</Badge>,
    },
    { key: "size", header: "Tamaño", numeric: true, cell: (f) => fmtFixed(f.size, 2) },
    { key: "price", header: "Precio", numeric: true, cell: (f) => fmtPrice(f.price) },
    { key: "notional", header: "Importe", numeric: true, cell: (f) => fmtUsd(f.size * f.price) },
    { key: "fee", header: "Fee", numeric: true, cell: (f) => fmtFixed(f.fee, 4) },
    {
      key: "pnl",
      header: "PnL",
      numeric: true,
      hint: "PnL realizado al cerrar contra el precio medio de entrada",
      cell: (f) => (f.side === "SELL" ? <Signed value={f.pnl} format={(n) => fmtFixed(n, 4)} /> : <span className="text-zinc-600">—</span>),
    },
    {
      key: "reason",
      header: "Motivo",
      cell: (f) => <span className="text-zinc-300">{REASONS[f.reason.split(" ")[0]] ?? (f.reason || "—")}</span>,
    },
    { key: "mode", header: "Modo", cell: (f) => <Badge>{f.mode}</Badge> },
  ];
}

const REASONS: Record<string, string> = {
  entry: "Entrada",
  take_profit: "Take profit",
  stop_loss: "Stop loss",
  max_hold: "Tiempo máximo",
  signal_reversal: "Señal invertida",
  signal_faded: "Señal agotada",
};

function PriceChart({
  label,
  color,
  points,
  fills,
  fitKey,
}: {
  label: string;
  color: string;
  points: FeaturePoint[];
  fills: Fill[];
  fitKey: string;
}) {
  const last = points.at(-1);
  return (
    <Card
      title={
        <span className="flex items-baseline gap-3">
          <span style={{ color }}>{label}</span>
          {last && (
            <span className="font-mono text-xs font-normal text-zinc-400">
              bid {fmtPrice(last.bid)} · ask {fmtPrice(last.ask)} · spread {fmtPrice(last.spread)} · imb {last.imbalance.toFixed(2)}
            </span>
          )}
        </span>
      }
    >
      <TimeSeries
        height={280}
        fitKey={fitKey}
        series={[
          {
            id: "mid",
            label: "mid",
            type: "area",
            color,
            data: points.map((p) => ({ ts: p.ts, value: p.mid })),
            markers: fills.map((f) => ({
              ts: f.ts,
              price: f.price,
              kind: f.side === "BUY" ? "buy" : "sell",
              text: `${f.side === "BUY" ? "C" : "V"} ${fmtFixed(f.size, 1)}`,
            })),
          },
          {
            id: "bid",
            label: "bid",
            type: "line",
            color: "#4ade80",
            lineWidth: 1,
            dashed: true,
            data: points.map((p) => ({ ts: p.ts, value: p.bid })),
          },
          {
            id: "ask",
            label: "ask",
            type: "line",
            color: "#f87171",
            lineWidth: 1,
            dashed: true,
            data: points.map((p) => ({ ts: p.ts, value: p.ask })),
          },
        ]}
      />
    </Card>
  );
}

function Shell({
  data,
  lagSeconds,
  children,
}: {
  data?: BotData;
  lagSeconds?: number;
  children: React.ReactNode;
}) {
  const running = lagSeconds !== undefined && lagSeconds < 20;
  const subtitle = data?.market.question ? (
    data.market.url ? (
      <a href={data.market.url} target="_blank" rel="noreferrer" className="hover:underline">
        {data.market.question} ↗
      </a>
    ) : (
      data.market.question
    )
  ) : undefined;
  return (
    <Page>
      <PageHeader title="En vivo" subtitle={subtitle}>
        {data && (
          <>
            <span className="rounded-md bg-white/10 px-2 py-1 font-mono uppercase">{data.config.mode}</span>
            {lagSeconds !== undefined && (
              <span className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${running ? "animate-pulse bg-emerald-400" : "bg-zinc-500"}`} />
                {running ? "Bot activo" : "Bot detenido"}
                {Number.isFinite(lagSeconds) && (
                  <span className="text-zinc-500">· export hace {Math.max(0, Math.round(lagSeconds))}s</span>
                )}
              </span>
            )}
            <span className="text-zinc-500">{data.totalFeatureRows.toLocaleString()} filas</span>
          </>
        )}
      </PageHeader>
      {children}
    </Page>
  );
}
