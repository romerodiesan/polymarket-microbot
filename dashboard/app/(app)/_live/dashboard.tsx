"use client";

import { Activity, ArrowLeftRight, Banknote, ExternalLink, Layers, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ToneBadge } from "@/components/app/indicators";
import { Kpi, KpiGrid } from "@/components/app/kpi";
import { EmptyState, Notice, Page, PageHeader, PageSkeleton, Panel } from "@/components/app/page";
import { ChartGroup } from "@/components/charts/chart-group";
import type { Separator } from "@/components/charts/separators";
import { useChartTheme } from "@/components/charts/theme";
import { type ChartSeries, TimeSeries } from "@/components/charts/time-series";
import type { BotData } from "@/lib/data";
import { fmtFixed, fmtInt, fmtTime, fmtUsd } from "@/lib/format";
import { FillsTable } from "./fills-table";
import { bucketed, drawdownOf, equityCurve, outcomes, portfolioAt, upTo } from "./model";
import { PriceChart } from "./price-chart";
import { ChartViewBar, useChartView } from "./controls/chart-view";
import { LiveControls } from "./controls/live-controls";
import { useLiveControls } from "./controls/use-live-controls";

const POLL_MS = 3000;

export default function Dashboard() {
  const theme = useChartTheme();
  const [data, setData] = useState<BotData | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    let min = Infinity;
    let max = -Infinity;
    for (const points of Object.values(data.features)) {
      if (!points.length) continue;
      min = Math.min(min, points[0].ts);
      max = Math.max(max, points[points.length - 1].ts);
    }
    if (!Number.isFinite(min)) return null;
    // A fill can land just after the last feature sample; keep it visible in live mode.
    const lastFill = data.fills.at(-1);
    if (lastFill && lastFill.ts > max) max = lastFill.ts;
    return { min, max };
  }, [data]);

  const controls = useLiveControls(range);
  const { t, live, showBidAsk, showFills } = controls;
  const scoreView = useChartView("score", range);
  const equityView = useChartView("equity", range, Infinity);

  const curve = useMemo(() => (data ? equityCurve(data) : []), [data]);
  const sides = useMemo(() => (data ? outcomes(data, theme) : []), [data, theme]);
  const breaks = useMemo(() => data?.markets.slice(1).map((m) => m.start) ?? [], [data]);
  const marketStarts = useMemo(() => data?.markets.map((m) => m.start) ?? [], [data]);
  const separators = useMemo<Separator[]>(
    () => data?.markets.map((m) => ({ ts: m.start, label: fmtTime(m.start).slice(0, 5) })) ?? [],
    [data],
  );

  const header = (
    <PageHeader
      title="En vivo"
      description={
        data?.market.question ? (
          data.market.url ? (
            <a
              href={data.market.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline-offset-4 hover:text-foreground hover:underline"
            >
              {data.market.question}
              <ExternalLink className="size-3.5" />
            </a>
          ) : (
            data.market.question
          )
        ) : undefined
      }
    >
      {data && <ToneBadge>{fmtInt(data.totalFeatureRows)} filas</ToneBadge>}
    </PageHeader>
  );

  if (!data) {
    return (
      <Page>
        {header}
        {error ? <Notice tone="error">Error leyendo datos: {error}</Notice> : <PageSkeleton />}
      </Page>
    );
  }
  if (!range) {
    return (
      <Page>
        {header}
        <EmptyState icon={Activity} title="Aún no hay datos">
          Arranca el bot con <code className="font-mono">microbot</code>; exporta Parquet cada pocos segundos a{" "}
          <code className="font-mono">data/parquet/</code>.
        </EmptyState>
      </Page>
    );
  }

  const portfolio = portfolioAt(data, t);
  const visibleFills = data.fills.filter((f) => f.ts <= t);
  const threshold = data.config.signalThreshold;
  const visibleCurve = upTo(curve, t);
  const drawdown = drawdownOf(visibleCurve);
  const maxDrawdown = drawdown.reduce((acc, p) => Math.min(acc, p.value), 0);
  const currentMarketStart = data.markets.at(-1)?.start ?? range.min;
  const yesPosition = portfolio.positions[data.tokens.yes] ?? 0;
  const noPosition = portfolio.positions[data.tokens.no] ?? 0;

  const yes = sides[0];
  const scoreSeries: ChartSeries[] = [
    {
      id: "score",
      label: "señal",
      type: "line",
      color: theme.accent,
      lineWidth: 2,
      data: bucketed(upTo(yes.points, t), (p) => p.score, scoreView.interval, breaks),
      priceLines: [
        { price: threshold, color: theme.up, title: "compra YES" },
        { price: 0, color: theme.zeroLine },
        { price: -threshold, color: theme.down, title: "compra NO" },
      ],
    },
  ];
  const equitySeries: ChartSeries[] = [
    {
      id: "equity",
      label: "equity",
      type: "baseline",
      color: theme.violet,
      baseValue: data.config.startingCash,
      data: bucketed(visibleCurve, (p) => p.equity, equityView.interval, []),
    },
    {
      id: "drawdown",
      label: "drawdown",
      type: "area",
      pane: 1,
      color: theme.down,
      lineWidth: 1,
      data: bucketed(drawdown, (p) => p.value, equityView.interval, []),
    },
  ];

  return (
    <Page className="pb-36 md:pb-6">
      {header}
      {error && <Notice tone="warn">No se pudo actualizar: {error}</Notice>}

      <LiveControls c={controls} markets={marketStarts} fills={data.fills} theme={theme} />

      <KpiGrid>
        <Kpi label="Equity" icon={Wallet} value={fmtUsd(portfolio.equity)} />
        <Kpi
          label="PnL"
          icon={portfolio.pnl < 0 ? TrendingDown : TrendingUp}
          value={fmtUsd(portfolio.pnl)}
          tone={portfolio.pnl > 0 ? "up" : portfolio.pnl < 0 ? "down" : undefined}
        />
        <Kpi
          label="Máx. drawdown"
          icon={TrendingDown}
          value={fmtUsd(maxDrawdown)}
          tone={maxDrawdown < 0 ? "down" : undefined}
        />
        <Kpi label="Cash" icon={Banknote} value={fmtUsd(portfolio.cash)} />
        <Kpi
          label="Posición"
          icon={Layers}
          value={`${fmtFixed(yesPosition, 2)} / ${fmtFixed(noPosition, 2)}`}
          hint="YES / NO"
        />
        <Kpi label="Fills" icon={ArrowLeftRight} value={fmtInt(visibleFills.length)} />
      </KpiGrid>

      <ChartGroup edge={t}>
        <div className="grid gap-4 md:gap-6">
          {sides.map((side) => (
            <PriceChart
              key={side.label}
              side={side}
              t={t}
              range={range}
              live={live}
              fills={showFills ? visibleFills.filter((f) => side.tokens.has(f.token_id)) : []}
              breaks={breaks}
              separators={separators}
              showBidAsk={showBidAsk}
              marketStart={currentMarketStart}
              theme={theme}
            />
          ))}
        </div>
        <section className="grid gap-4 md:gap-6 xl:grid-cols-2">
          <Panel title="Señal del mercado" description="Score YES; NO es su espejo">
            <ChartViewBar view={scoreView} live={live} candles={false} />
            <TimeSeries
              className="h-[200px] md:h-[240px]"
              precision={2}
              series={scoreSeries}
              separators={separators}
              viewport={scoreView.viewport}
            />
          </Panel>
          <Panel title="Equity y drawdown" description={`Base ${fmtUsd(data.config.startingCash)}`}>
            <ChartViewBar view={equityView} live={live} candles={false} />
            <TimeSeries
              className="h-[200px] md:h-[240px]"
              precision={2}
              series={equitySeries}
              separators={separators}
              lowerPaneRatio={0.3}
              viewport={equityView.viewport}
            />
          </Panel>
        </section>
      </ChartGroup>

      <Panel title="Fills" actions={<ToneBadge>{fmtInt(visibleFills.length)}</ToneBadge>}>
        <FillsTable fills={visibleFills} tokens={data.tokens} />
      </Panel>
    </Page>
  );
}
