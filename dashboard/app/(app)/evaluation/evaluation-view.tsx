"use client";

import {
  Banknote,
  History,
  Loader2,
  Percent,
  Play,
  Receipt,
  Scale,
  Square,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { changedText, usePoll } from "@/hooks/use-poll";
import { toast } from "sonner";
import { type Column, DataTable } from "@/components/app/data-table";
import { Signed, type Tone, ToneBadge } from "@/components/app/indicators";
import { Kpi, KpiGrid } from "@/components/app/kpi";
import { EmptyState, Notice, Page, PageHeader, PageSkeleton, Panel } from "@/components/app/page";
import { BarSeries } from "@/components/charts/bar-series";
import { useChartTheme } from "@/components/charts/theme";
import { XYLines } from "@/components/charts/xy-lines";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  Evaluation,
  EvaluationReport,
  EvaluationStatus,
  ModelOption,
  ScenarioReport,
} from "@/lib/evaluations";
import { fmtDateTime, fmtDuration, fmtFixed, fmtInt, fmtUsd } from "@/lib/format";

const POLL_MS = 2000;
/** List polling while nothing is evaluating (a run started from the CLI shows up within this). */
const IDLE_POLL_MS = 15000;
const RECORDED = "__recorded";

const STATUS: Record<EvaluationStatus, { label: string; tone: Tone }> = {
  running: { label: "En curso", tone: "sky" },
  succeeded: { label: "Completada", tone: "green" },
  failed: { label: "Falló", tone: "red" },
  stopped: { label: "Detenida", tone: "neutral" },
  interrupted: { label: "Interrumpida", tone: "amber" },
};

const SCENARIO_LABELS: Record<string, string> = { base: "Base", pessimistic: "Pesimista", stress: "Estrés" };
const SIGNAL_LABELS: Record<string, string> = {
  recorded: "Score grabado",
  model: "Modelo",
  momentum: "Momentum",
  random: "Aleatorio",
};
const scenarioLabel = (name: string) => SCENARIO_LABELS[name] ?? name;

type Tab = "new" | "history" | "result";
type Detail = Evaluation & { log: string; report: EvaluationReport | null };

const dash = <span className="text-muted-foreground/50">—</span>;
const pct = (n: number | null | undefined, digits = 1) => (n == null ? "—" : `${(n * 100).toFixed(digits)}%`);
const num = (n: number | null | undefined, digits = 2) => (n == null ? "—" : fmtFixed(n, digits));
const money = (n: number | null | undefined) => (n == null ? dash : <Signed value={n} format={(v) => fmtFixed(v, 2)} />);

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

function StatusBadge({ status }: { status: EvaluationStatus }) {
  const s = STATUS[status];
  return <ToneBadge tone={s.tone}>{s.label}</ToneBadge>;
}

function historyColumns(now: number, stop: (id: string) => void): Column<Evaluation>[] {
  const pnl = (name: string): Column<Evaluation> => ({
    key: name,
    header: `PnL ${scenarioLabel(name).toLowerCase()}`,
    numeric: true,
    hideOnMobile: name === "stress",
    cell: (e) => money(e.summary?.netPnl[name]),
  });
  return [
    {
      key: "started",
      header: "Inicio",
      cell: (e) => <span className="font-mono tabular-nums">{fmtDateTime(e.startedAt)}</span>,
    },
    { key: "status", header: "Estado", cell: (e) => <StatusBadge status={e.status} /> },
    {
      key: "signal",
      header: "Señal",
      hideOnMobile: true,
      cell: (e) => (e.signal ? (SIGNAL_LABELS[e.signal] ?? e.signal) : dash),
    },
    {
      key: "duration",
      header: "Duración",
      numeric: true,
      hideOnMobile: true,
      cell: (e) => (e.params ? fmtDuration((e.endedAt ?? now) - e.startedAt) : dash),
    },
    {
      key: "markets",
      header: "Mercados",
      numeric: true,
      hint: "Incluidos (excluidos por no resueltos con inventario)",
      cell: (e) =>
        e.summary ? `${e.summary.markets}${e.summary.excluded ? ` (${e.summary.excluded})` : ""}` : dash,
    },
    pnl("base"),
    pnl("pessimistic"),
    pnl("stress"),
    {
      key: "actions",
      header: <span className="sr-only">Acciones</span>,
      cell: (e) =>
        e.status === "running" ? (
          <Button
            size="sm"
            variant="destructive"
            className="h-7 text-xs"
            onClick={(ev) => {
              ev.stopPropagation();
              stop(e.id);
            }}
            disabled={e.stopRequested}
          >
            {e.stopRequested ? "Deteniendo…" : "Detener"}
          </Button>
        ) : null,
    },
  ];
}

export default function EvaluationView() {
  const [evaluations, setEvaluations] = useState<Evaluation[] | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [model, setModel] = useState(RECORDED);
  const [latency, setLatency] = useState("");
  const [fetchResolutions, setFetchResolutions] = useState(true);
  const [walkForward, setWalkForward] = useState(false);
  const [noL2, setNoL2] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const running = evaluations?.find((e) => e.status === "running");
  const listText = useRef<string | null>(null);
  const detailText = useRef<string | null>(null);

  usePoll(
    async (signal) => {
      try {
        const res = await fetch("/api/evaluations", { cache: "no-store", signal });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
        const text = await changedText(res, listText);
        if (signal.aborted) return;
        if (text !== null) {
          const data = JSON.parse(text) as { evaluations: Evaluation[]; models: ModelOption[] };
          setEvaluations(data.evaluations);
          setModels(data.models);
        }
        setNow(Date.now() / 1000);
      } catch (e) {
        if (!signal.aborted) setError(e instanceof Error ? e.message : String(e));
      }
    },
    running ? POLL_MS : IDLE_POLL_MS,
    [],
  );

  const currentId = selectedId ?? evaluations?.[0]?.id ?? null;
  const currentStatus = evaluations?.find((e) => e.id === currentId)?.status;

  usePoll(
    async (signal) => {
      if (!currentId) return;
      try {
        const res = await fetch(`/api/evaluations/${currentId}`, { cache: "no-store", signal });
        if (!res.ok) throw new Error(res.statusText);
        const text = await changedText(res, detailText);
        if (text !== null && !signal.aborted) setDetail(JSON.parse(text));
      } catch {
        if (!signal.aborted) {
          detailText.current = null;
          setDetail(null);
        }
      }
    },
    currentStatus === "running" ? POLL_MS : null,
    [currentId, currentStatus],
  );
  const activeTab: Tab = tab ?? (evaluations?.length ? "result" : "new");

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const evaluation = await request<Evaluation>("/api/evaluations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: model === RECORDED ? null : model,
          latencyMs: latency === "" ? null : Number(latency),
          fetchResolutions,
          walkForward,
          noL2,
        }),
      });
      listText.current = null;
      setEvaluations((prev) => [evaluation, ...(prev ?? [])]);
      setSelectedId(evaluation.id);
      setTab("result");
      toast.success("Evaluación iniciada");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast.error("No se pudo iniciar la evaluación", { description: message });
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    try {
      const evaluation = await request<Evaluation>(`/api/evaluations/${id}/stop`, { method: "POST" });
      listText.current = null;
      setEvaluations((prev) => prev?.map((e) => (e.id === id ? evaluation : e)) ?? null);
      toast("Deteniendo evaluación…");
    } catch (e) {
      toast.error("No se pudo detener", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Page>
      <PageHeader
        title="Evaluación"
        description="Replay cronológico de la estrategia (microbot-evaluate) contra el libro grabado, con liquidación oficial 0/1, comisiones reales y escenarios pesimistas."
      >
        {running && (
          <>
            <ToneBadge tone="sky" className="gap-1.5 py-1">
              <Loader2 className="animate-spin" /> En curso
            </ToneBadge>
            <Button size="sm" variant="destructive" className="h-8" onClick={() => stop(running.id)} disabled={running.stopRequested}>
              <Square />
              {running.stopRequested ? "Deteniendo…" : "Detener"}
            </Button>
          </>
        )}
      </PageHeader>

      {!evaluations ? (
        error ? <Notice tone="error">{error}</Notice> : <PageSkeleton kpis={0} panels={2} />
      ) : (
        <Tabs value={activeTab} onValueChange={(v) => setTab(v as Tab)} className="gap-4 md:gap-6">
          <TabsList className="w-full sm:w-fit">
            <TabsTrigger value="new" className="flex-1 sm:flex-none">
              <Play /> Nueva
            </TabsTrigger>
            <TabsTrigger value="history" className="flex-1 sm:flex-none">
              <History /> Historial
              <span className="font-mono text-xs text-muted-foreground">{evaluations.length}</span>
            </TabsTrigger>
            <TabsTrigger value="result" className="flex-1 sm:flex-none">
              <Target /> Resultado
            </TabsTrigger>
          </TabsList>

          <TabsContent value="new">
            <Panel title="Nueva evaluación" description="Lee los Parquet exportados, así que puede ejecutarse con el bot en marcha.">
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  start();
                }}
              >
                <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
                  <div className="grid gap-2">
                    <Label htmlFor="model">Señal</Label>
                    <Select value={model} onValueChange={setModel}>
                      <SelectTrigger id="model" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={RECORDED}>Score grabado</SelectItem>
                        {models.map((m) => (
                          <SelectItem key={m.path} value={m.path}>
                            {m.label}
                            {m.active ? " · activo" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="latency">Latencia base (ms)</Label>
                    <Input
                      id="latency"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={10}
                      placeholder="RTT medida"
                      value={latency}
                      onChange={(e) => setLatency(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                </div>
                <div className="grid gap-3 lg:max-w-xl">
                  {[
                    {
                      id: "fetch",
                      label: "Buscar en Gamma las resoluciones y comisiones que falten",
                      checked: fetchResolutions,
                      onChange: setFetchResolutions,
                    },
                    {
                      id: "walk",
                      label: "Walk-forward: reentrenar por bloques de mercados y evaluar el siguiente",
                      checked: walkForward,
                      onChange: setWalkForward,
                    },
                    {
                      id: "nol2",
                      label: "Ignorar el libro L2 grabado (aproximar con top y profundidad)",
                      checked: noL2,
                      onChange: setNoL2,
                    },
                  ].map((s) => (
                    <div key={s.id} className="flex items-center gap-3">
                      <Switch id={s.id} checked={s.checked} onCheckedChange={s.onChange} />
                      <Label htmlFor={s.id} className="font-normal">
                        {s.label}
                      </Label>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground lg:max-w-xl">
                  Escenarios: base (latencia ×1, sin ticks extra, comisión ×1, todo el tamaño visible), pesimista (×2,
                  +1 tick, ×1,5, 50 %) y estrés (×4, +2 ticks, ×2, 25 %). Los mercados sin resolver que acaban con
                  inventario se excluyen.
                </p>
                {error && <Notice tone="error">{error}</Notice>}
                <div>
                  <Button type="submit" disabled={busy || !!running} className="w-full sm:w-auto">
                    {busy ? <Loader2 className="animate-spin" /> : <Play />}
                    {busy ? "Iniciando…" : running ? "Ya hay una evaluación en curso" : "Ejecutar"}
                  </Button>
                </div>
              </form>
            </Panel>
          </TabsContent>

          <TabsContent value="history">
            <Panel title="Historial" description="Pulsa una fila para ver su informe.">
              <DataTable
                columns={historyColumns(now, stop)}
                rows={evaluations}
                rowKey={(e) => e.id}
                onRowClick={(e) => {
                  setSelectedId(e.id);
                  setTab("result");
                }}
                selectedKey={currentId}
                maxHeight={480}
                empty="Todavía no hay evaluaciones. Lanza la primera desde la pestaña Nueva."
              />
            </Panel>
          </TabsContent>

          <TabsContent value="result" className="flex flex-col gap-4 md:gap-6">
            {detail && detail.id === currentId ? (
              <DetailView detail={detail} />
            ) : currentId ? (
              <PageSkeleton kpis={6} panels={1} />
            ) : (
              <EmptyState icon={Scale} title="Sin evaluaciones">
                Lanza la primera desde la pestaña Nueva.
              </EmptyState>
            )}
          </TabsContent>
        </Tabs>
      )}
    </Page>
  );
}

function DetailView({ detail }: { detail: Detail }) {
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail.log]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <StatusBadge status={detail.status} />
        <span>Iniciada {fmtDateTime(detail.startedAt)}</span>
        {detail.report && (
          <>
            <span>· señal {SIGNAL_LABELS[detail.report.signal] ?? detail.report.signal}</span>
            {detail.report.model && <span className="font-mono text-xs">· {detail.report.model}</span>}
            <span>· latencia base {fmtInt(detail.report.latency_ms)} ms</span>
            <span>· comisión por defecto {detail.report.fee_rate}</span>
          </>
        )}
      </div>
      {detail.report ? <ReportView report={detail.report} /> : null}
      {(detail.log || detail.params) && (
        <Panel
          title="Log"
          actions={detail.exitCode !== null && <span className="font-mono text-xs text-muted-foreground">exit {detail.exitCode}</span>}
        >
          <pre
            ref={logRef}
            className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed"
          >
            {detail.log || "(sin salida todavía)"}
          </pre>
        </Panel>
      )}
    </>
  );
}

type ScenarioRow = ScenarioReport & { name: string };

const scenarioColumns: Column<ScenarioRow>[] = [
  { key: "name", header: "Escenario", cell: (s) => scenarioLabel(s.name) },
  {
    key: "settings",
    header: "Latencia · ticks · comisión · fill",
    hideOnMobile: true,
    cell: (s) => (
      <span className="font-mono text-xs text-muted-foreground">
        ×{s.latency_multiplier} · +{s.extra_slippage_ticks} · ×{s.fee_multiplier} · {pct(s.fill_haircut, 0)}
      </span>
    ),
  },
  { key: "pnl", header: "PnL neto", numeric: true, cell: (s) => money(s.net_pnl) },
  {
    key: "ci",
    header: "IC 95 %",
    numeric: true,
    hint: "Bootstrap por mercados del PnL total",
    cell: (s) => (s.bootstrap ? `${fmtFixed(s.bootstrap.total_pnl.low, 2)} – ${fmtFixed(s.bootstrap.total_pnl.high, 2)}` : dash),
  },
  { key: "fees", header: "Comisiones", numeric: true, cell: (s) => fmtFixed(s.fees, 2) },
  { key: "entries", header: "Entradas", numeric: true, cell: (s) => fmtInt(s.entries) },
  { key: "exp", header: "PnL / op.", numeric: true, cell: (s) => money(s.expectancy_per_trade) },
  { key: "expm", header: "PnL / mercado", numeric: true, hideOnMobile: true, cell: (s) => money(s.expectancy_per_market) },
  { key: "roi", header: "ROI", numeric: true, hint: "Sobre el capital máximo comprometido", cell: (s) => pct(s.roi_on_max_committed) },
  { key: "sharpe", header: "Sharpe", numeric: true, hideOnMobile: true, hint: "Por mercado", cell: (s) => num(s.sharpe_per_market) },
  { key: "sortino", header: "Sortino", numeric: true, hideOnMobile: true, hint: "Por mercado", cell: (s) => num(s.sortino_per_market) },
  { key: "pf", header: "Profit factor", numeric: true, hideOnMobile: true, cell: (s) => num(s.profit_factor) },
  { key: "win", header: "Win rate ops.", numeric: true, hideOnMobile: true, cell: (s) => pct(s.win_rate_trades) },
  { key: "dd", header: "Máx. DD", numeric: true, cell: (s) => fmtFixed(-s.drawdown.max, 2) },
  { key: "fill", header: "Fill / rechazo", numeric: true, hideOnMobile: true, cell: (s) => `${pct(s.execution.fill_rate, 0)} / ${pct(s.execution.reject_rate, 0)}` },
];

type MarketRow = {
  market: string;
  endTs: number | null;
  pnl: Record<string, number>;
  fees: number;
  entries: number;
  settledBy: string;
  fidelity: string;
};

const SETTLED: Record<string, { label: string; tone: Tone }> = {
  payout: { label: "pago 0/1", tone: "green" },
  flat: { label: "sin inventario", tone: "neutral" },
  unresolved: { label: "excluido", tone: "amber" },
};

function marketColumns(scenarios: string[]): Column<MarketRow>[] {
  return [
    {
      key: "market",
      header: "Mercado",
      cell: (r) => <span className="font-mono text-xs">{r.market}</span>,
    },
    {
      key: "end",
      header: "Fin",
      hideOnMobile: true,
      cell: (r) => (r.endTs ? <span className="font-mono tabular-nums">{fmtDateTime(r.endTs)}</span> : dash),
    },
    ...scenarios.map<Column<MarketRow>>((name) => ({
      key: name,
      header: scenarioLabel(name),
      numeric: true,
      cell: (r) => money(r.pnl[name]),
    })),
    { key: "fees", header: "Comisiones base", numeric: true, hideOnMobile: true, cell: (r) => fmtFixed(r.fees, 2) },
    { key: "entries", header: "Entradas", numeric: true, cell: (r) => fmtInt(r.entries) },
    {
      key: "settled",
      header: "Liquidación",
      cell: (r) => {
        const s = SETTLED[r.settledBy] ?? { label: r.settledBy, tone: "neutral" as Tone };
        return <ToneBadge tone={s.tone}>{s.label}</ToneBadge>;
      },
    },
    {
      key: "fidelity",
      header: "Libro",
      hideOnMobile: true,
      cell: (r) => <ToneBadge tone={r.fidelity === "l2" ? "sky" : "amber"}>{r.fidelity === "l2" ? "L2" : "aprox."}</ToneBadge>,
    },
  ];
}

type WeekRow = { week: string; markets: number; pnl: number; fees: number; entries: number };
const weekColumns: Column<WeekRow>[] = [
  { key: "week", header: "Semana", cell: (w) => <span className="font-mono">{w.week}</span> },
  { key: "markets", header: "Mercados", numeric: true, cell: (w) => fmtInt(w.markets) },
  { key: "entries", header: "Entradas", numeric: true, cell: (w) => fmtInt(w.entries) },
  { key: "fees", header: "Comisiones", numeric: true, cell: (w) => fmtFixed(w.fees, 2) },
  { key: "pnl", header: "PnL", numeric: true, cell: (w) => money(w.pnl) },
];

type FoldRow = NonNullable<EvaluationReport["walk_forward"]>["folds"][number];
const foldColumns: Column<FoldRow>[] = [
  { key: "fold", header: "Fold", cell: (f) => f.fold },
  { key: "markets", header: "Mercados train / eval.", numeric: true, cell: (f) => `${f.train_markets} / ${f.valid_markets}` },
  { key: "base", header: "PnL base", numeric: true, cell: (f) => (f.error ? dash : money(f.scenarios?.base?.net_pnl)) },
  {
    key: "pess",
    header: "PnL pesimista",
    numeric: true,
    cell: (f) => (f.error ? <span className="text-xs text-muted-foreground">{f.error}</span> : money(f.scenarios?.pessimistic?.net_pnl)),
  },
  { key: "entries", header: "Entradas", numeric: true, cell: (f) => (f.error ? dash : fmtInt(f.scenarios?.pessimistic?.entries ?? NaN)) },
];

function ReportView({ report }: { report: EvaluationReport }) {
  const theme = useChartTheme();
  const names = Object.keys(report.scenarios);
  const rows: ScenarioRow[] = names.map((name) => ({ name, ...report.scenarios[name] }));
  const main = report.scenarios.pessimistic ?? report.scenarios.base ?? rows[0];
  if (!main) return <Notice tone="warn">El informe no contiene escenarios.</Notice>;
  const base = report.scenarios.base ?? main;

  const ci = main.bootstrap?.total_pnl;
  const ciCrossesZero = ci ? ci.low < 0 && ci.high > 0 : true;
  const mainTone = main.net_pnl > 0 && !ciCrossesZero ? "up" : main.net_pnl < 0 ? "down" : undefined;

  const markets = new Map<string, MarketRow>();
  for (const name of names) {
    for (const m of report.scenarios[name].per_market) {
      const row = markets.get(m.market) ?? {
        market: m.market,
        endTs: m.end_ts ?? null,
        pnl: {},
        fees: 0,
        entries: 0,
        settledBy: m.settled_by,
        fidelity: m.fidelity,
      };
      row.pnl[name] = m.pnl;
      if (name === "base") {
        row.fees = m.fees;
        row.entries = m.entries;
      }
      markets.set(m.market, row);
    }
  }
  const marketRows = [...markets.values()].sort((a, b) => (a.endTs ?? 0) - (b.endTs ?? 0) || a.market.localeCompare(b.market));
  const included = marketRows.filter((r) => r.settledBy !== "unresolved");
  const colors: Record<string, string> = { base: theme.accent, pessimistic: theme.sell, stress: theme.down };
  const cumulative = names.map((name) => {
    let total = 0;
    return {
      id: name,
      label: scenarioLabel(name),
      color: colors[name] ?? theme.violet,
      points: included.map((r, i) => ({ x: i + 1, y: (total += r.pnl[name] ?? 0) })),
    };
  });

  const bars = [
    ...rows.map((s) => ({ x: scenarioLabel(s.name), value: s.net_pnl })),
    ...Object.entries(report.baselines ?? {}).map(([name, b]) => ({
      x: `${SIGNAL_LABELS[name] ?? name} (base)`,
      value: b.net_pnl,
    })),
  ];
  const weeks: WeekRow[] = Object.entries(main.weekly)
    .map(([week, w]) => ({ week, ...w }))
    .sort((a, b) => a.week.localeCompare(b.week));
  const paper = report.paper_vs_replay;
  const featuresOnly = (main.markets.fidelity.features ?? 0) > 0;

  return (
    <>
      <KpiGrid>
        <Kpi
          label={`PnL neto (${scenarioLabel(main === report.scenarios.pessimistic ? "pessimistic" : "base").toLowerCase()})`}
          icon={main.net_pnl < 0 ? TrendingDown : TrendingUp}
          value={fmtUsd(main.net_pnl)}
          tone={mainTone}
          hint={ci ? `IC 95 % ${fmtFixed(ci.low, 2)} – ${fmtFixed(ci.high, 2)}` : "sin IC (menos de 2 mercados)"}
        />
        <Kpi label="Comisiones" icon={Receipt} value={fmtUsd(main.fees)} hint={`base ${fmtUsd(base.fees)}`} />
        <Kpi
          label="PnL por operación"
          icon={Target}
          value={main.expectancy_per_trade == null ? "—" : fmtFixed(main.expectancy_per_trade, 4)}
          tone={main.expectancy_per_trade == null ? undefined : main.expectancy_per_trade > 0 ? "up" : "down"}
          hint={`${fmtInt(main.entries)} entradas`}
        />
        <Kpi
          label="ROI"
          icon={Percent}
          value={pct(main.roi_on_max_committed, 2)}
          hint={`sobre ${fmtUsd(main.max_capital_committed)} comprometidos`}
        />
        <Kpi
          label="Máx. drawdown"
          icon={TrendingDown}
          value={fmtUsd(-main.drawdown.max)}
          tone={main.drawdown.max > 0 ? "down" : undefined}
          hint={`${main.drawdown.duration_markets} mercados · ${fmtDuration(main.drawdown.duration_seconds)}`}
        />
        <Kpi
          label="Mercados"
          icon={Banknote}
          value={fmtInt(main.markets.included)}
          hint={`${main.markets.traded} operados · ${main.markets.excluded_unresolved} excluidos`}
        />
      </KpiGrid>

      {featuresOnly && (
        <Notice tone="warn">
          {main.markets.fidelity.features} de {main.markets.included} mercados se ejecutaron contra un libro aproximado
          (top y profundidad) porque no hay L2 grabado; los fills son menos fiables.
        </Notice>
      )}
      {main.markets.excluded_unresolved > 0 && (
        <Notice>
          {main.markets.excluded_unresolved} mercados sin resolución oficial acabaron con inventario y se excluyeron.
          Vuelve a evaluar con &quot;buscar resoluciones en Gamma&quot; cuando se hayan resuelto.
        </Notice>
      )}
      {main.net_pnl > 0 && ciCrossesZero && (
        <Notice tone="warn">El PnL es positivo, pero su intervalo de confianza incluye 0: no es distinguible de la suerte.</Notice>
      )}

      <Panel title="Escenarios" description="Cada escenario reproduce los mismos mercados con fills más pesimistas">
        <DataTable columns={scenarioColumns} rows={rows} rowKey={(s) => s.name} />
        <p className="mt-3 text-xs text-muted-foreground">
          Concentración: los 5 mejores mercados suman {fmtFixed(main.concentration.top5_pnl, 2)}
          {main.concentration.top5_share_of_net != null && ` (${pct(main.concentration.top5_share_of_net, 0)} del neto)`}.
          Slippage medio de entrada frente al touch: {num(main.execution.mean_entry_slippage_vs_touch, 4)}.
        </p>
      </Panel>

      <section className="grid gap-4 md:gap-6 lg:grid-cols-2">
        <Panel title="PnL neto" description="Escenarios de la estrategia y baselines con fills base">
          <BarSeries
            data={bars}
            orientation="rows"
            label="PnL"
            color={theme.up}
            colorOf={(b) => (b.value >= 0 ? theme.up : theme.down)}
            showValues
            formatValue={(v) => fmtFixed(v, 2)}
            height={Math.max(160, bars.length * 34 + 40)}
            categoryWidth={150}
          />
        </Panel>
        <Panel title="PnL acumulado por mercado" description="Mercados incluidos, en orden de cierre">
          <XYLines
            series={cumulative}
            zeroLine
            formatX={(v) => String(Math.round(v))}
            formatY={(v) => fmtFixed(v, 2)}
            xLabel={(x) => included[x - 1]?.market ?? `#${x}`}
          />
        </Panel>
      </section>

      <section className="grid gap-4 md:gap-6 lg:grid-cols-2">
        <Panel title="Paper frente al replay" description="PnL sobre los mercados que comparten el paper registrado y el replay">
          {paper && paper.markets ? (
            <div className="grid gap-2 text-sm">
              {["paper", ...names].map((name) => (
                <div key={name} className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">{name === "paper" ? "Paper registrado" : scenarioLabel(name)}</span>
                  <span className="font-mono tabular-nums">{money(paper[name])}</span>
                </div>
              ))}
              {paper.paper_minus_pessimistic !== undefined && (
                <p className="mt-2 text-xs text-muted-foreground">
                  El paper supera al escenario pesimista en {fmtFixed(paper.paper_minus_pessimistic, 2)} en {paper.markets}{" "}
                  mercados: es lo que el paper sobrestima si la ejecución real es pesimista.
                </p>
              )}
            </div>
          ) : (
            <EmptyState icon={Scale} title="Sin datos comunes">
              No hay mercados con fills paper y replay a la vez.
            </EmptyState>
          )}
        </Panel>
        <Panel title="Por semana" description={`Escenario ${scenarioLabel(main === report.scenarios.pessimistic ? "pessimistic" : "base").toLowerCase()}`}>
          <DataTable columns={weekColumns} rows={weeks} rowKey={(w) => w.week} />
        </Panel>
      </section>

      {report.walk_forward && (
        <Panel
          title="Walk-forward"
          description={`Reentrenado por bloques; ${report.walk_forward.pessimistic_positive_folds} folds positivos en el escenario pesimista, neto ${fmtFixed(report.walk_forward.pessimistic_net_pnl, 2)}`}
        >
          <DataTable columns={foldColumns} rows={report.walk_forward.folds} rowKey={(f) => String(f.fold)} />
        </Panel>
      )}

      <Panel title="Mercados" actions={<ToneBadge>{marketRows.length}</ToneBadge>}>
        <DataTable columns={marketColumns(names)} rows={marketRows} rowKey={(r) => r.market} maxHeight={480} />
      </Panel>
    </>
  );
}
