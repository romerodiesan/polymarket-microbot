"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BarSeries } from "@/components/charts/bar-series";
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
  fmtBytes,
  fmtDateTime,
  fmtDuration,
  fmtFixed,
  fmtInt,
  fmtPrice,
  fmtSmart,
  fmtTime,
} from "@/components/ui";
import type { CollectionData, FeatureStat, Session, TokenSummary } from "@/lib/collection";

const POLL_MS = 5000;
const LIVE_EXPORT_SECONDS = 20;

const FEATURE_DESCRIPTIONS: Record<string, string> = {
  spread_ticks: "Spread en ticks (coste de cruzar el libro)",
  weighted_imbalance: "Desequilibrio de 5 niveles, ponderado hacia el mejor precio",
  book_imbalance: "Desequilibrio bid/ask de 3 niveles (−1 a 1)",
  microprice_delta: "Microprecio frente al mid, en spreads",
  ofi: "Order flow imbalance (Cont–Kukanov–Stoikov) con decaimiento temporal",
  flow_imbalance: "Cambio de profundidad bid frente a ask entre muestras",
  trade_pressure: "Presión compradora/vendedora de trades, con decaimiento temporal",
  volatility: "Volatilidad del mid por minuto (EWMA)",
};

type RecentRow = CollectionData["recent"][number];
type SessionRow = Session & { index: number; live: boolean };

const num = (row: RecentRow, key: string) => Number(row[key]);

const tokenColumns: Column<TokenSummary>[] = [
  { key: "token", header: "Token", cell: (t) => <TokenBadge label={t.label} /> },
  { key: "rows", header: "Filas", numeric: true, cell: (t) => fmtInt(t.rows) },
  {
    key: "range",
    header: "Periodo",
    cell: (t) => (
      <span title={`${fmtDateTime(t.first)} – ${fmtDateTime(t.last)}`} className="font-mono tabular-nums text-zinc-300">
        {fmtTime(t.first)} – {fmtTime(t.last)}
      </span>
    ),
  },
  { key: "last", header: "Último mid", numeric: true, cell: (t) => fmtPrice(t.lastMid) },
  {
    key: "mid",
    header: "Rango mid",
    numeric: true,
    hint: "Mínimo y máximo del midpoint en los datos",
    cell: (t) => (
      <span className="text-zinc-300">
        {fmtPrice(t.minMid)} <span className="text-zinc-600">–</span> {fmtPrice(t.maxMid)}
      </span>
    ),
  },
  { key: "spread", header: "Spread medio", numeric: true, cell: (t) => fmtFixed(t.avgSpread, 4) },
  {
    key: "score",
    header: "Score medio",
    numeric: true,
    hint: "Media de la señal (−1 a 1); positivo = sesgo comprador",
    cell: (t) => <Signed value={t.avgScore} format={(n) => fmtFixed(n, 3)} epsilon={5e-4} />,
  },
];

const featureColumns: Column<FeatureStat>[] = [
  {
    key: "name",
    header: "Feature",
    className: "min-w-36 max-w-44 whitespace-normal sm:max-w-none",
    cell: (f) => (
      <div className="flex flex-col">
        <span className="font-mono text-[13px] text-zinc-200">{f.name}</span>
        <span className="text-xs text-zinc-500">{FEATURE_DESCRIPTIONS[f.name]}</span>
      </div>
    ),
  },
  { key: "mean", header: "Media", numeric: true, cell: (f) => fmtSmart(f.mean) },
  { key: "std", header: "Desv. est.", numeric: true, cell: (f) => fmtSmart(f.std) },
  { key: "min", header: "Mín", numeric: true, cell: (f) => fmtSmart(f.min) },
  { key: "max", header: "Máx", numeric: true, cell: (f) => fmtSmart(f.max) },
];

const sessionColumns: Column<SessionRow>[] = [
  { key: "index", header: "#", numeric: true, cell: (s) => <span className="text-zinc-500">{s.index}</span> },
  {
    key: "status",
    header: "Estado",
    cell: (s) => (s.live ? <Badge tone="green">● En curso</Badge> : <Badge>Finalizada</Badge>),
  },
  { key: "start", header: "Inicio", cell: (s) => <span className="tabular-nums">{fmtDateTime(s.start)}</span> },
  { key: "end", header: "Fin", cell: (s) => <span className="tabular-nums">{s.live ? "—" : fmtDateTime(s.end)}</span> },
  { key: "duration", header: "Duración", numeric: true, cell: (s) => fmtDuration(s.end - s.start) },
  { key: "rows", header: "Filas", numeric: true, cell: (s) => fmtInt(s.rows) },
  {
    key: "rate",
    header: "Filas/min",
    numeric: true,
    cell: (s) => (s.end > s.start ? fmtInt((s.rows / (s.end - s.start)) * 60) : "—"),
  },
];

const recentColumns: Column<RecentRow>[] = [
  { key: "ts", header: "Hora", cell: (r) => <span className="font-mono tabular-nums text-zinc-300">{fmtTime(num(r, "ts"))}</span> },
  { key: "token", header: "Token", cell: (r) => <TokenBadge label={String(r.token_id)} /> },
  { key: "bid", header: "Bid", numeric: true, cell: (r) => fmtPrice(num(r, "best_bid")) },
  { key: "ask", header: "Ask", numeric: true, cell: (r) => fmtPrice(num(r, "best_ask")) },
  { key: "mid", header: "Mid", numeric: true, cell: (r) => <span className="text-zinc-100">{fmtPrice(num(r, "midpoint"))}</span> },
  { key: "spread", header: "Spread", numeric: true, cell: (r) => fmtFixed(num(r, "spread"), 3) },
  {
    key: "imbalance",
    header: "Imbalance",
    numeric: true,
    hint: FEATURE_DESCRIPTIONS.book_imbalance,
    cell: (r) => <Signed value={num(r, "book_imbalance")} format={(n) => fmtFixed(n, 3)} epsilon={5e-4} />,
  },
  {
    key: "flow",
    header: "Flujo",
    numeric: true,
    hint: FEATURE_DESCRIPTIONS.flow_imbalance,
    cell: (r) => <Signed value={num(r, "flow_imbalance")} format={(n) => fmtFixed(n, 3)} epsilon={5e-4} />,
  },
  {
    key: "pressure",
    header: "Presión",
    numeric: true,
    hint: FEATURE_DESCRIPTIONS.trade_pressure,
    cell: (r) => <Signed value={num(r, "trade_pressure")} format={(n) => fmtFixed(n, 3)} epsilon={5e-4} />,
  },
  {
    key: "score",
    header: "Score",
    numeric: true,
    cell: (r) => (
      <span className="font-semibold">
        <Signed value={num(r, "score")} format={(n) => fmtFixed(n, 3)} epsilon={5e-4} />
      </span>
    ),
  },
];

export default function CollectionView() {
  const [data, setData] = useState<CollectionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/collection", { cache: "no-store" });
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

  if (!data) {
    return (
      <Page>
        <PageHeader title="Recopilación de datos" />
        {error ? <Notice tone="error">Error leyendo datos: {error}</Notice> : <Notice>Cargando…</Notice>}
      </Page>
    );
  }

  const coverage = data.first && data.last ? data.last - data.first : 0;
  const recorded = data.sessions.reduce((acc, s) => acc + (s.end - s.start), 0);
  const { training } = data;
  const progress = Math.min(1, training.usable / training.minRows);
  const botLive = !!data.exportedAt && now > 0 && now - data.exportedAt < LIVE_EXPORT_SECONDS;
  const sessions: SessionRow[] = data.sessions.map((s, i) => ({
    ...s,
    index: data.sessions.length - i,
    live: i === 0 && botLive,
  }));

  return (
    <Page>
      <PageHeader title="Recopilación de datos" subtitle={data.market.question ?? undefined}>
        {data.exportedAt && (
          <span className="flex items-center gap-2 text-zinc-400">
            <span className={`h-2 w-2 rounded-full ${botLive ? "animate-pulse bg-emerald-400" : "bg-zinc-500"}`} />
            Último export {fmtDateTime(data.exportedAt)}
          </span>
        )}
      </PageHeader>

      {error && <Notice tone="error">Error actualizando: {error}</Notice>}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Filas de features" value={fmtInt(data.totalRows)} />
        <Kpi label="Fills registrados" value={fmtInt(data.totalFills)} />
        <Kpi label="Sesiones" value={String(data.sessions.length)} hint="cortes de más de 60 s" />
        <Kpi label="Tiempo grabado" value={fmtDuration(recorded)} />
        <Kpi label="Cobertura total" value={fmtDuration(coverage)} hint={data.first ? `desde ${fmtTime(data.first)}` : undefined} />
        <Kpi label="Filas / minuto" value={recorded > 0 ? fmtInt((data.totalRows / recorded) * 60) : "—"} />
      </section>

      <Card
        title="Preparación para entrenar"
        actions={
          <Link href="/training" className="rounded-md bg-white/10 px-3 py-1 text-xs hover:bg-white/20">
            Ir a entrenamiento →
          </Link>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div
              className="h-2 min-w-40 flex-1 overflow-hidden rounded-full bg-white/10"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={training.minRows}
              aria-valuenow={Math.min(training.usable, training.minRows)}
              aria-label="Filas recopiladas para entrenar"
            >
              <div
                className={`h-full ${training.ready ? "bg-emerald-500" : "bg-amber-500"}`}
                style={{ width: `${progress * 100}%` }}
              />
            </div>
            <span className="font-mono tabular-nums text-zinc-300">
              {fmtInt(training.usable)} / {fmtInt(training.minRows)} filas con todas las features
            </span>
          </div>
          <p className="text-zinc-400">
            Con los parámetros por defecto (horizonte {training.horizonSeconds} s; el movimiento debe superar
            medio spread + {training.minMove}) hay <b className="text-zinc-200">{fmtInt(training.labelled)}</b> ejemplos
            etiquetados: <span className="text-emerald-400">{fmtInt(training.ups)} subidas</span> y{" "}
            <span className="text-red-400">{fmtInt(training.downs)} bajadas</span>.{" "}
            {training.ready
              ? "Hay datos suficientes para entrenar."
              : `Aún faltan datos: el entrenador necesita al menos ${fmtInt(training.minRows)} filas con todas las features y ejemplos de subidas y bajadas.`}
          </p>
        </div>
      </Card>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <Card title="Filas recopiladas por minuto">
            {data.perMinute.length === 0 ? (
              <p className="py-10 text-center text-sm text-zinc-400">Sin datos todavía.</p>
            ) : (
              <BarSeries
                data={data.perMinute.map((m) => ({ x: m.ts, value: m.rows }))}
                label="Filas"
                color="#38bdf8"
                formatX={(ts) => fmtTime(Number(ts)).slice(0, 5)}
                formatLabel={(m) => fmtDateTime(Number(m.x))}
              />
            )}
          </Card>
        </div>
        <Card title="Archivos">
          <ul className="flex flex-col divide-y divide-white/5 text-sm">
            {data.files.filter((f) => f !== null).map((f) => (
              <li key={f.name} className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <span className="min-w-0 truncate font-mono text-[13px] text-zinc-300" title={f.name}>
                  {f.name}
                </span>
                <span className="shrink-0 font-mono tabular-nums text-zinc-400">{fmtBytes(f.bytes)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <Card title="Resumen por token">
        <DataTable columns={tokenColumns} rows={data.tokens} rowKey={(t) => t.token} />
      </Card>

      <section className="grid gap-4 xl:grid-cols-5">
        <div className="min-w-0 xl:col-span-3">
          <Card title="Features del modelo">
            <DataTable columns={featureColumns} rows={data.featureStats} rowKey={(f) => f.name} />
          </Card>
        </div>
        <div className="min-w-0 xl:col-span-2">
          <Card title={`Sesiones (${data.sessions.length})`}>
            <DataTable
              columns={sessionColumns}
              rows={sessions}
              rowKey={(s) => String(s.start)}
              maxHeight={360}
              empty="Todavía no hay sesiones grabadas."
            />
          </Card>
        </div>
      </section>

      <Card
        title="Últimas filas"
        actions={<span className="text-xs text-zinc-500">{data.recent.length} más recientes · se actualiza cada 5 s</span>}
      >
        <DataTable
          columns={recentColumns}
          rows={data.recent}
          rowKey={(r) => `${r.ts}-${r.token_id}`}
          maxHeight={440}
          empty="El bot aún no ha registrado features."
        />
      </Card>
    </Page>
  );
}
