"use client";

import { useEffect, useRef, useState } from "react";
import { BarSeries } from "@/components/charts/bar-series";
import {
  Card,
  Kpi,
  Notice,
  Page,
  PageHeader,
  Badge,
  type Column,
  DataTable,
  fmtFixed,
  fmtInt,
  fmtDateTime,
  fmtDuration,
  fmtNum,
} from "@/components/ui";
import type { Run, RunStatus } from "@/lib/training";

const POLL_MS = 2000;

const STATUS: Record<RunStatus, { label: string; tone: "sky" | "green" | "red" | "neutral" | "amber" }> = {
  running: { label: "En curso", tone: "sky" },
  succeeded: { label: "Completado", tone: "green" },
  failed: { label: "Falló", tone: "red" },
  stopped: { label: "Detenido", tone: "neutral" },
  interrupted: { label: "Interrumpido", tone: "amber" },
};

type RunDetail = Run & { log: string };

type ReportRow = { name: string; precision: number; recall: number; f1: number; support: number };

const reportColumns: Column<ReportRow>[] = [
  { key: "name", header: "Clase", cell: (r) => r.name },
  { key: "precision", header: "Precision", numeric: true, cell: (r) => fmtFixed(r.precision, 4) },
  { key: "recall", header: "Recall", numeric: true, cell: (r) => fmtFixed(r.recall, 4) },
  { key: "f1", header: "F1", numeric: true, cell: (r) => fmtFixed(r.f1, 4) },
  { key: "support", header: "Soporte", numeric: true, cell: (r) => fmtInt(r.support) },
];

function historyColumns(now: number, stop: (id: string) => void): Column<Run>[] {
  return [
    {
      key: "started",
      header: "Inicio",
      cell: (r) => <span className="font-mono tabular-nums text-zinc-300">{fmtDateTime(r.startedAt)}</span>,
    },
    {
      key: "status",
      header: "Estado",
      cell: (r) => (
        <span className="flex items-center gap-1.5">
          <StatusBadge status={r.status} />
          {r.active && <Badge tone="violet">modelo activo</Badge>}
        </span>
      ),
    },
    {
      key: "duration",
      header: "Duración",
      numeric: true,
      cell: (r) => fmtDuration((r.endedAt ?? now) - r.startedAt),
    },
    {
      key: "horizon",
      header: "Horizonte",
      numeric: true,
      cell: (r) =>
        r.params.horizonSeconds !== undefined
          ? `${r.params.horizonSeconds} s`
          : <span title="Entrenamiento antiguo, horizonte en muestras">{r.params.horizonSamples} m</span>,
    },
    { key: "minMove", header: "Mov. mín.", numeric: true, cell: (r) => r.params.minMove },
    {
      key: "auc",
      header: "ROC-AUC",
      numeric: true,
      hint: "Área bajo la curva ROC en test; 0.5 equivale a azar",
      cell: (r) =>
        r.metrics ? (
          <span className={r.metrics.roc_auc > 0.55 ? "text-emerald-400" : r.metrics.roc_auc < 0.5 ? "text-red-400" : ""}>
            {fmtFixed(r.metrics.roc_auc, 4)}
          </span>
        ) : (
          <span className="text-zinc-600">—</span>
        ),
    },
    {
      key: "rows",
      header: "Filas",
      numeric: true,
      cell: (r) => (r.metrics ? fmtInt(r.metrics.rows_total) : <span className="text-zinc-600">—</span>),
    },
    {
      key: "actions",
      header: <span className="sr-only">Acciones</span>,
      cell: (r) =>
        r.status === "running" ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              stop(r.id);
            }}
            disabled={r.stopRequested}
            className="rounded-md bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-300 hover:bg-red-500/25 disabled:opacity-40"
          >
            {r.stopRequested ? "Deteniendo…" : "Detener"}
          </button>
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    setError(null);
    try {
      const run = await request<Run>(`/api/training/${id}/stop`, { method: "POST" });
      setRuns((prev) => prev?.map((r) => (r.id === id ? run : r)) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Page>
      <PageHeader
        title="Entrenamiento"
        subtitle="Regresión logística sobre las features recopiladas (microbot-train), con validación temporal 80/20 y embargo igual al horizonte."
      />

      <Card title="Nuevo entrenamiento">
        <div className="flex flex-wrap items-end gap-4 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-zinc-400">Horizonte (segundos)</span>
            <input
              type="number"
              min={1}
              max={3600}
              step={1}
              value={horizon}
              onChange={(e) => setHorizon(e.target.value)}
              className="w-36 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-400">Movimiento mínimo</span>
            <input
              type="number"
              min={0}
              step={0.001}
              value={minMove}
              onChange={(e) => setMinMove(e.target.value)}
              className="w-36 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 font-mono"
            />
          </label>
          <button
            onClick={start}
            disabled={busy || !!running}
            className="rounded-md bg-emerald-500 px-4 py-1.5 font-medium text-black disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Iniciando…" : "▶ Ejecutar"}
          </button>
          {running && (
            <button
              onClick={() => stop(running.id)}
              disabled={running.stopRequested}
              className="rounded-md bg-red-500 px-4 py-1.5 font-medium text-black disabled:opacity-40"
            >
              {running.stopRequested ? "Deteniendo…" : "■ Detener"}
            </button>
          )}
          <p className="basis-full text-xs text-zinc-500">
            La etiqueta compara el mid actual con el de dentro del horizonte; solo cuentan los movimientos
            que superan medio spread + el movimiento mínimo (el coste de cruzar). Usa el Parquet exportado,
            así que puedes entrenar con el bot en marcha.
          </p>
        </div>
        {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
      </Card>

      <Card title={`Historial (${runs?.length ?? 0})`}>
        {!runs ? (
          <p className="py-6 text-center text-sm text-zinc-400">Cargando…</p>
        ) : (
          <DataTable
            columns={historyColumns(now, stop)}
            rows={runs}
            rowKey={(r) => r.id}
            onRowClick={(r) => setSelectedId(r.id)}
            selectedKey={currentId}
            maxHeight={320}
            empty="Todavía no hay entrenamientos. Lanza el primero arriba."
          />
        )}
      </Card>

      {detail && detail.id === currentId && <RunDetailView run={detail} />}
    </Page>
  );
}

function StatusBadge({ status }: { status: RunStatus }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

function RunDetailView({ run }: { run: RunDetail }) {
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

  return (
    <>
      {m && (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Kpi
              label="ROC-AUC (test)"
              value={fmtNum(m.roc_auc)}
              tone={m.roc_auc > 0.55 ? "up" : m.roc_auc < 0.5 ? "down" : undefined}
              hint="0.5 = azar"
            />
            <Kpi
              label="Filas utilizables"
              value={fmtInt(m.rows_usable ?? m.rows_total)}
              hint={`de ${fmtInt(m.rows_total)} totales`}
            />
            <Kpi
              label="Etiquetadas"
              value={fmtInt(m.rows_labelled)}
              hint={
                m.class_counts
                  ? (() => {
                      const ups = (m.class_counts.train["1"] ?? 0) + (m.class_counts.test["1"] ?? 0);
                      const downs = (m.class_counts.train["0"] ?? 0) + (m.class_counts.test["0"] ?? 0);
                      return `${fmtInt(ups)} suben · ${fmtInt(downs)} bajan`;
                    })()
                  : undefined
              }
            />
            <Kpi
              label="Train / test"
              value={`${fmtInt(m.train_rows)} / ${fmtInt(m.test_rows)}`}
              hint={m.embargo_seconds !== undefined ? `embargo ${m.embargo_seconds} s` : undefined}
            />
            <Kpi label="Accuracy" value={typeof m.report.accuracy === "number" ? fmtNum(m.report.accuracy) : "—"} />
            <Kpi
              label="Accuracy alta confianza"
              value={m.high_confidence?.accuracy != null ? fmtNum(m.high_confidence.accuracy) : "—"}
              hint={
                m.high_confidence
                  ? `p ≥ ${m.high_confidence.threshold} o ≤ ${fmtFixed(1 - m.high_confidence.threshold, 2)} · ${(m.high_confidence.coverage * 100).toFixed(1)}% del test`
                  : undefined
              }
            />
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <Card title="Reporte de clasificación (test)">
              <DataTable columns={reportColumns} rows={reportRows} rowKey={(r) => r.name} />
            </Card>
            <Card title="Coeficientes (features estandarizadas)">
              <BarSeries
                data={coefficients}
                orientation="rows"
                label="Coeficiente"
                color="#22c55e"
                colorOf={(c) => (c.value >= 0 ? "#22c55e" : "#ef4444")}
                formatValue={(v) => fmtFixed(v, 3)}
                height={Math.max(200, coefficients.length * 30 + 40)}
                categoryWidth={124}
              />
            </Card>
          </section>

          <Notice>
            Modelo guardado en <code className="font-mono">{run.modelPath}</code>.{" "}
            {run.active ? (
              <span className="text-violet-300">Es el modelo que usa el bot ahora.</span>
            ) : (
              <>
                Para usarlo, pon <code className="font-mono">PM_MODEL_PATH={run.modelPath}</code> en{" "}
                <code className="font-mono">.env</code> y reinicia <code className="font-mono">microbot</code>.
              </>
            )}
          </Notice>
        </>
      )}

      <Card
        title={
          <span className="flex items-center gap-2">
            Log <StatusBadge status={run.status} />
            {run.exitCode !== null && <span className="text-xs font-normal text-zinc-500">exit {run.exitCode}</span>}
          </span>
        }
      >
        <pre
          ref={logRef}
          className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-black/50 p-3 font-mono text-xs leading-relaxed text-zinc-300"
        >
          {run.log || "(sin salida todavía)"}
        </pre>
      </Card>
    </>
  );
}
