"use client";

import { ArrowLeftRight, ArrowRight, BarChart3, Clock, FileArchive, Gauge, History, Rows3 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ChoiceGroup } from "@/components/app/choice-group";
import { type Column, DataTable } from "@/components/app/data-table";
import { Signed, StatusDot, ToneBadge, TokenBadge } from "@/components/app/indicators";
import { Kpi, KpiGrid } from "@/components/app/kpi";
import { EmptyState, Notice, Page, PageHeader, PageSkeleton, Panel } from "@/components/app/page";
import { useChartTheme } from "@/components/charts/theme";
import { type ChartSeries, TimeSeries } from "@/components/charts/time-series";
import { Button } from "@/components/ui/button";
import type { CollectionData, FeatureStat, Resolution, Session, TokenSummary } from "@/lib/collection";
import {
  fmtBytes,
  fmtDateTime,
  fmtDay,
  fmtDuration,
  fmtFixed,
  fmtInt,
  fmtPrice,
  fmtSmart,
  fmtTime,
} from "@/lib/format";
import { cn } from "@/lib/utils";

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

const RESOLUTIONS: Record<Resolution, {
  label: string;
  title: string;
  /** Axis ticks; the chart's time-of-day/date default when omitted. */
  formatTick?: (ts: number) => string;
  formatLabel: (ts: number) => string;
}> = {
  minute: {
    label: "Min",
    title: "Filas recopiladas por minuto",
    formatLabel: (ts) => fmtDateTime(ts).slice(0, -3),
  },
  hour: {
    label: "Horas",
    title: "Filas recopiladas por hora",
    formatLabel: (ts) => `${fmtDateTime(ts).slice(0, -6)}:00`,
  },
  day: {
    label: "Días",
    title: "Filas recopiladas por día",
    formatTick: fmtDay,
    formatLabel: (ts) => new Date(ts * 1000).toLocaleDateString("es", { dateStyle: "full" }),
  },
};
const RESOLUTION_OPTIONS = (Object.keys(RESOLUTIONS) as Resolution[]).map((r) => ({ value: r, label: RESOLUTIONS[r].label }));

type RecentRow = CollectionData["recent"][number];
type SessionRow = Session & { index: number; live: boolean };

const num = (row: RecentRow, key: string) => Number(row[key]);
const signed3 = (n: number) => fmtFixed(n, 3);

const tokenColumns: Column<TokenSummary>[] = [
  {
    key: "token",
    header: "Token",
    cell: (t) => (
      <span className="flex items-center gap-2">
        <TokenBadge label={t.label} />
        {t.market && <span className="font-mono text-xs text-muted-foreground">{t.market}</span>}
      </span>
    ),
  },
  { key: "rows", header: "Filas", numeric: true, cell: (t) => fmtInt(t.rows) },
  {
    key: "range",
    header: "Periodo",
    hideOnMobile: true,
    cell: (t) => (
      <span title={`${fmtDateTime(t.first)} – ${fmtDateTime(t.last)}`} className="font-mono tabular-nums">
        {fmtTime(t.first)} – {fmtTime(t.last)}
      </span>
    ),
  },
  { key: "last", header: "Último mid", numeric: true, cell: (t) => fmtPrice(t.lastMid) },
  {
    key: "mid",
    header: "Rango mid",
    numeric: true,
    hideOnMobile: true,
    hint: "Mínimo y máximo del midpoint en los datos",
    cell: (t) => (
      <span>
        {fmtPrice(t.minMid)} <span className="text-muted-foreground">–</span> {fmtPrice(t.maxMid)}
      </span>
    ),
  },
  { key: "spread", header: "Spread medio", numeric: true, hideOnMobile: true, cell: (t) => fmtFixed(t.avgSpread, 4) },
  {
    key: "score",
    header: "Score medio",
    numeric: true,
    hint: "Media de la señal (−1 a 1); positivo = sesgo comprador",
    cell: (t) => <Signed value={t.avgScore} format={signed3} epsilon={5e-4} />,
  },
];

const featureColumns: Column<FeatureStat>[] = [
  {
    key: "name",
    header: "Feature",
    className: "min-w-36 max-w-44 whitespace-normal sm:max-w-none",
    cell: (f) => (
      <div className="flex flex-col">
        <span className="font-mono text-[13px]">{f.name}</span>
        <span className="text-xs text-muted-foreground">{FEATURE_DESCRIPTIONS[f.name]}</span>
      </div>
    ),
  },
  { key: "mean", header: "Media", numeric: true, cell: (f) => fmtSmart(f.mean) },
  { key: "std", header: "Desv. est.", numeric: true, cell: (f) => fmtSmart(f.std) },
  { key: "min", header: "Mín", numeric: true, hideOnMobile: true, cell: (f) => fmtSmart(f.min) },
  { key: "max", header: "Máx", numeric: true, hideOnMobile: true, cell: (f) => fmtSmart(f.max) },
];

const sessionColumns: Column<SessionRow>[] = [
  { key: "index", header: "#", numeric: true, cell: (s) => <span className="text-muted-foreground">{s.index}</span> },
  {
    key: "status",
    header: "Estado",
    cell: (s) =>
      s.live ? (
        <ToneBadge tone="green"><StatusDot active /> En curso</ToneBadge>
      ) : (
        <ToneBadge>Finalizada</ToneBadge>
      ),
  },
  { key: "start", header: "Inicio", cell: (s) => <span className="tabular-nums">{fmtDateTime(s.start)}</span> },
  {
    key: "end",
    header: "Fin",
    hideOnMobile: true,
    cell: (s) => <span className="tabular-nums">{s.live ? "—" : fmtDateTime(s.end)}</span>,
  },
  { key: "duration", header: "Duración", numeric: true, cell: (s) => fmtDuration(s.end - s.start) },
  { key: "rows", header: "Filas", numeric: true, cell: (s) => fmtInt(s.rows) },
  {
    key: "rate",
    header: "Filas/min",
    numeric: true,
    hideOnMobile: true,
    cell: (s) => (s.end > s.start ? fmtInt((s.rows / (s.end - s.start)) * 60) : "—"),
  },
];

const recentColumns: Column<RecentRow>[] = [
  { key: "ts", header: "Hora", cell: (r) => <span className="font-mono tabular-nums">{fmtTime(num(r, "ts"))}</span> },
  { key: "token", header: "Token", cell: (r) => <TokenBadge label={String(r.token_id)} /> },
  { key: "bid", header: "Bid", numeric: true, hideOnMobile: true, cell: (r) => fmtPrice(num(r, "best_bid")) },
  { key: "ask", header: "Ask", numeric: true, hideOnMobile: true, cell: (r) => fmtPrice(num(r, "best_ask")) },
  { key: "mid", header: "Mid", numeric: true, cell: (r) => <span className="font-medium">{fmtPrice(num(r, "midpoint"))}</span> },
  { key: "spread", header: "Spread", numeric: true, hideOnMobile: true, cell: (r) => fmtFixed(num(r, "spread"), 3) },
  {
    key: "imbalance",
    header: "Imbalance",
    numeric: true,
    hideOnMobile: true,
    hint: FEATURE_DESCRIPTIONS.book_imbalance,
    cell: (r) => <Signed value={num(r, "book_imbalance")} format={signed3} epsilon={5e-4} />,
  },
  {
    key: "flow",
    header: "Flujo",
    numeric: true,
    hideOnMobile: true,
    hint: FEATURE_DESCRIPTIONS.flow_imbalance,
    cell: (r) => <Signed value={num(r, "flow_imbalance")} format={signed3} epsilon={5e-4} />,
  },
  {
    key: "pressure",
    header: "Presión",
    numeric: true,
    hideOnMobile: true,
    hint: FEATURE_DESCRIPTIONS.trade_pressure,
    cell: (r) => <Signed value={num(r, "trade_pressure")} format={signed3} epsilon={5e-4} />,
  },
  {
    key: "score",
    header: "Score",
    numeric: true,
    cell: (r) => (
      <span className="font-semibold">
        <Signed value={num(r, "score")} format={signed3} epsilon={5e-4} />
      </span>
    ),
  },
];

export default function CollectionView() {
  const theme = useChartTheme();
  const [data, setData] = useState<CollectionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [resolution, setResolution] = useState<Resolution>("minute");

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
        {error ? <Notice tone="error">Error leyendo datos: {error}</Notice> : <PageSkeleton panels={3} />}
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
  const buckets = data.rowsOverTime[resolution];
  const active = buckets.filter((b) => b.rows > 0);
  const average = active.length ? active.reduce((acc, b) => acc + b.rows, 0) / active.length : 0;
  const rowSeries: ChartSeries[] = buckets.length
    ? [
        {
          id: "rows",
          label: "filas",
          type: "histogram",
          color: theme.accent,
          data: buckets.map((b) => ({ ts: b.ts, value: b.rows })),
          priceLines: active.length ? [{ price: average, color: theme.textStrong, title: "media" }] : [],
        },
      ]
    : [];
  const files = data.files.filter((f) => f !== null);

  return (
    <Page>
      <PageHeader title="Recopilación de datos" description={data.market.question ?? undefined}>
        {data.exportedAt && (
          <ToneBadge className="gap-2 py-1">
            <StatusDot active={botLive} />
            Último export {fmtDateTime(data.exportedAt)}
          </ToneBadge>
        )}
      </PageHeader>

      {error && <Notice tone="warn">No se pudo actualizar: {error}</Notice>}

      <KpiGrid>
        <Kpi label="Filas de features" icon={Rows3} value={fmtInt(data.totalRows)} />
        <Kpi label="Fills registrados" icon={ArrowLeftRight} value={fmtInt(data.totalFills)} />
        <Kpi label="Sesiones" icon={History} value={String(data.sessions.length)} hint="cortes de más de 60 s" />
        <Kpi label="Tiempo grabado" icon={Clock} value={fmtDuration(recorded)} />
        <Kpi
          label="Cobertura total"
          icon={BarChart3}
          value={fmtDuration(coverage)}
          hint={data.first ? `desde ${fmtTime(data.first)}` : undefined}
        />
        <Kpi label="Filas / minuto" icon={Gauge} value={recorded > 0 ? fmtInt((data.totalRows / recorded) * 60) : "—"} />
      </KpiGrid>

      <Panel
        title="Preparación para entrenar"
        actions={
          <Button asChild size="sm" variant="outline" className="h-8">
            <Link href="/training">
              <span className="hidden sm:inline">Ir a entrenamiento</span>
              <span className="sm:hidden">Entrenar</span>
              <ArrowRight />
            </Link>
          </Button>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            <div
              className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={training.minRows}
              aria-valuenow={Math.min(training.usable, training.minRows)}
              aria-label="Filas recopiladas para entrenar"
            >
              <div
                className={cn("h-full rounded-full transition-[width]", training.ready ? "bg-emerald-500" : "bg-amber-500")}
                style={{ width: `${progress * 100}%` }}
              />
            </div>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {fmtInt(training.usable)} / {fmtInt(training.minRows)} filas con todas las features
            </span>
          </div>
          <p className="text-muted-foreground">
            Con los parámetros por defecto (horizonte {training.horizonSeconds} s; el movimiento debe superar
            medio spread + {training.minMove}) hay <b className="text-foreground">{fmtInt(training.labelled)}</b> ejemplos
            etiquetados: <span className="text-up">{fmtInt(training.ups)} subidas</span> y{" "}
            <span className="text-down">{fmtInt(training.downs)} bajadas</span>.{" "}
            {training.ready
              ? "Hay datos suficientes para entrenar."
              : `Aún faltan datos: el entrenador necesita al menos ${fmtInt(training.minRows)} filas con todas las features y ejemplos de subidas y bajadas.`}
          </p>
        </div>
      </Panel>

      <section className="grid gap-4 md:gap-6 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title={RESOLUTIONS[resolution].title}
          description={active.length ? `Media ${fmtInt(average)} filas por intervalo activo` : undefined}
          actions={<ChoiceGroup label="Temporalidad" options={RESOLUTION_OPTIONS} value={resolution} onChange={setResolution} />}
        >
          {rowSeries.length === 0 ? (
            <EmptyState icon={BarChart3} title="Sin datos todavía" />
          ) : (
            <TimeSeries
              className="h-[220px] md:h-[280px]"
              precision={0}
              fitKey={resolution}
              formatTick={RESOLUTIONS[resolution].formatTick}
              formatTime={RESOLUTIONS[resolution].formatLabel}
              series={rowSeries}
            />
          )}
        </Panel>
        <Panel title="Archivos" actions={<ToneBadge>{files.length}</ToneBadge>}>
          {files.length === 0 ? (
            <EmptyState icon={FileArchive} title="Sin archivos" />
          ) : (
            <ul className="flex flex-col divide-y text-sm">
              {files.map((f) => (
                <li key={f.name} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <FileArchive className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-[13px]" title={f.name}>{f.name}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{fmtBytes(f.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </section>

      <Panel title="Resumen por token" actions={<ToneBadge>{data.tokens.length}</ToneBadge>}>
        <DataTable columns={tokenColumns} rows={data.tokens} rowKey={(t) => t.token} maxHeight={420} />
      </Panel>

      <section className="grid gap-4 md:gap-6 xl:grid-cols-5">
        <Panel className="xl:col-span-3" title="Features del modelo">
          <DataTable columns={featureColumns} rows={data.featureStats} rowKey={(f) => f.name} />
        </Panel>
        <Panel className="xl:col-span-2" title="Sesiones" actions={<ToneBadge>{data.sessions.length}</ToneBadge>}>
          <DataTable
            columns={sessionColumns}
            rows={sessions}
            rowKey={(s) => String(s.start)}
            maxHeight={360}
            empty="Todavía no hay sesiones grabadas."
          />
        </Panel>
      </section>

      <Panel title="Últimas filas" description={`${data.recent.length} más recientes · se actualiza cada 5 s`}>
        <DataTable
          columns={recentColumns}
          rows={data.recent}
          rowKey={(r) => `${r.ts}-${r.token_id}`}
          maxHeight={440}
          empty="El bot aún no ha registrado features."
        />
      </Panel>
    </Page>
  );
}
