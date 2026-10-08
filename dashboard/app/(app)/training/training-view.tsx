"use client";

import { BrainCircuit, Gauge, History, Loader2, Play, Rows3, Split, Square, Tags, Target } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { type Column, DataTable } from "@/components/app/data-table";
import { type Tone, ToneBadge } from "@/components/app/indicators";
import { Kpi, KpiGrid } from "@/components/app/kpi";
import { EmptyState, Notice, Page, PageHeader, PageSkeleton, Panel } from "@/components/app/page";
import { BarSeries } from "@/components/charts/bar-series";
import { useChartTheme } from "@/components/charts/theme";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/use-mobile";
import { fmtDateTime, fmtDuration, fmtFixed, fmtInt, fmtNum } from "@/lib/format";
import type { Run, RunStatus } from "@/lib/training";

const POLL_MS = 2000;

const STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  running: { label: "En curso", tone: "sky" },
  succeeded: { label: "Completado", tone: "green" },
  failed: { label: "Falló", tone: "red" },
  stopped: { label: "Detenido", tone: "neutral" },
  interrupted: { label: "Interrumpido", tone: "amber" },
};

type Tab = "new" | "history" | "result";
type RunDetail = Run & { log: string };

type ReportRow = { name: string; precision: number; recall: number; f1: number; support: number };

const reportColumns: Column<ReportRow>[] = [
  { key: "name", header: "Clase", cell: (r) => r.name },
  { key: "precision", header: "Precision", numeric: true, cell: (r) => fmtFixed(r.precision, 4) },
  { key: "recall", header: "Recall", numeric: true, cell: (r) => fmtFixed(r.recall, 4) },
  { key: "f1", header: "F1", numeric: true, cell: (r) => fmtFixed(r.f1, 4) },
  { key: "support", header: "Soporte", numeric: true, cell: (r) => fmtInt(r.support) },
];

const aucClass = (auc: number) => (auc > 0.55 ? "text-up" : auc < 0.5 ? "text-down" : "");

function historyColumns(now: number, stop: (id: string) => void): Column<Run>[] {
  return [
    {
      key: "started",
      header: "Inicio",
      cell: (r) => <span className="font-mono tabular-nums">{fmtDateTime(r.startedAt)}</span>,
    },
    {
      key: "status",
      header: "Estado",
      cell: (r) => (
        <span className="flex items-center gap-1.5">
          <StatusBadge status={r.status} />
          {r.active && <ToneBadge tone="violet">activo</ToneBadge>}
        </span>
      ),
    },
    {
      key: "duration",
      header: "Duración",
      numeric: true,
      hideOnMobile: true,
      cell: (r) => fmtDuration((r.endedAt ?? now) - r.startedAt),
    },
    {
      key: "horizon",
      header: "Horizonte",
      numeric: true,
      hideOnMobile: true,
      cell: (r) =>
        r.params.horizonSeconds !== undefined
          ? `${r.params.horizonSeconds} s`
          : <span title="Entrenamiento antiguo, horizonte en muestras">{r.params.horizonSamples} m</span>,
    },
    { key: "minMove", header: "Mov. mín.", numeric: true, hideOnMobile: true, cell: (r) => r.params.minMove },
    {
      key: "auc",
      header: "ROC-AUC",
      numeric: true,
      hint: "Área bajo la curva ROC en test; 0.5 equivale a azar",
      cell: (r) =>
        r.metrics ? (
          <span className={aucClass(r.metrics.roc_auc)}>{fmtFixed(r.metrics.roc_auc, 4)}</span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        ),
    },
    {
      key: "rows",
      header: "Filas",
      numeric: true,
      hideOnMobile: true,
      cell: (r) => (r.metrics ? fmtInt(r.metrics.rows_total) : <span className="text-muted-foreground/50">—</span>),
    },
    {
      key: "actions",
      header: <span className="sr-only">Acciones</span>,
      cell: (r) =>
        r.status === "running" ? (
          <Button
            size="sm"
            variant="destructive"
            className="h-7 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              stop(r.id);
            }}
            disabled={r.stopRequested}
          >
            {r.stopRequested ? "Deteniendo…" : "Detener"}
          </Button>
        ) : null,
    },
  ];
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

export default function TrainingView() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [horizon, setHorizon] = useState("15");
  const [minMove, setMinMove] = useState("0.002");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await request<Run[]>("/api/training");
        if (!cancelled) {
          setRuns(list);
          setNow(Date.now() / 1000);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const currentId = selectedId ?? runs?.[0]?.id ?? null;
  const currentStatus = runs?.find((r) => r.id === currentId)?.status;

  useEffect(() => {
    if (!currentId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const run = await request<RunDetail>(`/api/training/${currentId}`);
        if (!cancelled) setDetail(run);
      } catch {
        if (!cancelled) setDetail(null);
      }
    };
    load();
    if (currentStatus !== "running") return () => void (cancelled = true);
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [currentId, currentStatus]);

  const running = runs?.find((r) => r.status === "running");
  const activeTab: Tab = tab ?? (runs?.length ? "result" : "new");

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const run = await request<Run>("/api/training", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ horizonSeconds: Number(horizon), minMove: Number(minMove) }),
      });
      setRuns((prev) => [run, ...(prev ?? [])]);
      setSelectedId(run.id);
      setTab("result");
      toast.success("Entrenamiento iniciado", { description: `Horizonte ${horizon} s · movimiento mínimo ${minMove}` });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast.error("No se pudo iniciar el entrenamiento", { description: message });
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    setError(null);
    try {
      const run = await request<Run>(`/api/training/${id}/stop`, { method: "POST" });
      setRuns((prev) => prev?.map((r) => (r.id === id ? run : r)) ?? null);
      toast("Deteniendo entrenamiento…");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast.error("No se pudo detener", { description: message });
    }
  };

  return (
    <Page>
      <PageHeader
        title="Entrenamiento"
        description="Regresión logística sobre las features recopiladas (microbot-train), con validación temporal 80/20 y embargo igual al horizonte."
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

      {!runs ? (
        error ? <Notice tone="error">{error}</Notice> : <PageSkeleton kpis={0} panels={2} />
      ) : (
        <Tabs value={activeTab} onValueChange={(v) => setTab(v as Tab)} className="gap-4 md:gap-6">
          <TabsList className="w-full sm:w-fit">
            <TabsTrigger value="new" className="flex-1 sm:flex-none">
              <Play /> Nuevo
            </TabsTrigger>
            <TabsTrigger value="history" className="flex-1 sm:flex-none">
              <History /> Historial
              <span className="font-mono text-xs text-muted-foreground">{runs.length}</span>
            </TabsTrigger>
            <TabsTrigger value="result" className="flex-1 sm:flex-none">
              <Target /> Resultado
            </TabsTrigger>
          </TabsList>

          <TabsContent value="new">
            <Panel title="Nuevo entrenamiento" description="Usa el Parquet exportado, así que puedes entrenar con el bot en marcha.">
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  start();
                }}
              >
                <div className="grid gap-4 sm:grid-cols-2 lg:max-w-xl">
                  <div className="grid gap-2">
                    <Label htmlFor="horizon">Horizonte (segundos)</Label>
                    <Input
                      id="horizon"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={3600}
                      step={1}
                      value={horizon}
                      onChange={(e) => setHorizon(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="min-move">Movimiento mínimo</Label>
                    <Input
                      id="min-move"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={0.001}
                      value={minMove}
                      onChange={(e) => setMinMove(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground lg:max-w-xl">
                  La etiqueta compara el mid actual con el de dentro del horizonte; solo cuentan los movimientos que
                  superan medio spread + el movimiento mínimo (el coste de cruzar).
                </p>
                {error && <Notice tone="error">{error}</Notice>}
                <div>
                  <Button type="submit" disabled={busy || !!running} className="w-full sm:w-auto">
                    {busy ? <Loader2 className="animate-spin" /> : <Play />}
                    {busy ? "Iniciando…" : running ? "Ya hay un entrenamiento en curso" : "Ejecutar"}
                  </Button>
                </div>
              </form>
            </Panel>
          </TabsContent>

          <TabsContent value="history">
            <Panel title="Historial" description="Pulsa una fila para ver su resultado.">
              <DataTable
                columns={historyColumns(now, stop)}
                rows={runs}
                rowKey={(r) => r.id}
                onRowClick={(r) => {
                  setSelectedId(r.id);
                  setTab("result");
                }}
                selectedKey={currentId}
                maxHeight={480}
                empty="Todavía no hay entrenamientos. Lanza el primero desde la pestaña Nuevo."
              />
            </Panel>
          </TabsContent>

          <TabsContent value="result" className="flex flex-col gap-4 md:gap-6">
            {detail && detail.id === currentId ? (
              <RunDetailView run={detail} />
            ) : currentId ? (
              <PageSkeleton kpis={6} panels={1} />
            ) : (
              <EmptyState icon={BrainCircuit} title="Sin entrenamientos">
                Lanza el primero desde la pestaña Nuevo.
              </EmptyState>
            )}
          </TabsContent>
        </Tabs>
      )}
    </Page>
  );
}

function StatusBadge({ status }: { status: RunStatus }) {
  const s = STATUS[status];
  return <ToneBadge tone={s.tone}>{s.label}</ToneBadge>;
}

function RunDetailView({ run }: { run: RunDetail }) {
  const theme = useChartTheme();
  const isMobile = useIsMobile();
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run.log]);

  const m = run.metrics;
  const reportRows: ReportRow[] = m
    ? Object.entries(m.report)
        .filter((entry): entry is [string, Record<string, number>] => typeof entry[1] === "object")
        .map(([name, r]) => ({
          name: name === "0" ? "Baja (0)" : name === "1" ? "Sube (1)" : name,
          precision: r.precision,
          recall: r.recall,
          f1: r["f1-score"],
          support: r.support,
        }))
    : [];
  const coefficients = m
    ? Object.entries(m.coefficients)
        .map(([name, value]) => ({ x: name, value }))
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    : [];
  const classCounts = m?.class_counts;
  const ups = classCounts ? (classCounts.train["1"] ?? 0) + (classCounts.test["1"] ?? 0) : null;
  const downs = classCounts ? (classCounts.train["0"] ?? 0) + (classCounts.test["0"] ?? 0) : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <StatusBadge status={run.status} />
        <span>Iniciado {fmtDateTime(run.startedAt)}</span>
        {run.params.horizonSeconds !== undefined && <span>· horizonte {run.params.horizonSeconds} s</span>}
        <span>· mov. mín. {run.params.minMove}</span>
      </div>

      {m && (
        <>
          <KpiGrid>
            <Kpi
              label="ROC-AUC (test)"
              icon={Target}
              value={fmtNum(m.roc_auc)}
              tone={m.roc_auc > 0.55 ? "up" : m.roc_auc < 0.5 ? "down" : undefined}
              hint="0.5 = azar"
            />
            <Kpi
              label="Filas utilizables"
              icon={Rows3}
              value={fmtInt(m.rows_usable ?? m.rows_total)}
              hint={`de ${fmtInt(m.rows_total)} totales`}
            />
            <Kpi
              label="Etiquetadas"
              icon={Tags}
              value={fmtInt(m.rows_labelled)}
              hint={ups !== null && downs !== null ? `${fmtInt(ups)} suben · ${fmtInt(downs)} bajan` : undefined}
            />
            <Kpi
              label="Train / test"
              icon={Split}
              value={`${fmtInt(m.train_rows)} / ${fmtInt(m.test_rows)}`}
              hint={m.embargo_seconds !== undefined ? `embargo ${m.embargo_seconds} s` : undefined}
            />
            <Kpi
              label="Accuracy"
              icon={Gauge}
              value={typeof m.report.accuracy === "number" ? fmtNum(m.report.accuracy) : "—"}
            />
            <Kpi
              label="Accuracy alta confianza"
              icon={Gauge}
              value={m.high_confidence?.accuracy != null ? fmtNum(m.high_confidence.accuracy) : "—"}
              hint={
                m.high_confidence
                  ? `p ≥ ${m.high_confidence.threshold} · ${(m.high_confidence.coverage * 100).toFixed(1)}% del test`
                  : undefined
              }
            />
          </KpiGrid>

          <section className="grid gap-4 md:gap-6 lg:grid-cols-2">
            <Panel title="Reporte de clasificación" description="Conjunto de test">
              <DataTable columns={reportColumns} rows={reportRows} rowKey={(r) => r.name} />
            </Panel>
            <Panel title="Coeficientes" description="Features estandarizadas, ordenadas por magnitud">
              <BarSeries
                data={coefficients}
                orientation="rows"
                label="Coeficiente"
                color={theme.up}
                colorOf={(c) => (c.value >= 0 ? theme.up : theme.down)}
                showValues
                formatValue={(v) => fmtFixed(v, 3)}
                height={Math.max(180, coefficients.length * (isMobile ? 24 : 30) + 40)}
                categoryWidth={128}
              />
            </Panel>
          </section>

          <Notice>
            Modelo guardado en <code className="font-mono">{run.modelPath}</code>.{" "}
            {run.active ? (
              <span className="font-medium text-violet-600 dark:text-violet-300">Es el modelo que usa el bot ahora.</span>
            ) : (
              <>
                Para usarlo, pon <code className="font-mono">PM_MODEL_PATH={run.modelPath}</code> en{" "}
                <code className="font-mono">.env</code> y reinicia <code className="font-mono">microbot</code>.
              </>
            )}
          </Notice>
        </>
      )}

      <Panel
        title="Log"
        actions={run.exitCode !== null && <span className="font-mono text-xs text-muted-foreground">exit {run.exitCode}</span>}
      >
        <pre
          ref={logRef}
          className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed"
        >
          {run.log || "(sin salida todavía)"}
        </pre>
      </Panel>
    </>
  );
}
