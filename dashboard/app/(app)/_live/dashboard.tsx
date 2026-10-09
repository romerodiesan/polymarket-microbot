"use client";

import { Activity, ArrowLeftRight, Banknote, ExternalLink, Layers, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ToneBadge } from "@/components/app/indicators";
import { Kpi, KpiGrid } from "@/components/app/kpi";
import { EmptyState, Notice, Page, PageHeader, PageSkeleton, Panel } from "@/components/app/page";
import { type Candle, candleSeries } from "@/components/charts/candles";
import { ChartGroup } from "@/components/charts/chart-group";
import type { Separator } from "@/components/charts/separators";
import { useChartTheme } from "@/components/charts/theme";
import { type ChartSeries, TimeSeries } from "@/components/charts/time-series";
import type { LivePayload } from "@/lib/data";
import { fmtInt, fmtFixed, fmtTime, fmtUsd } from "@/lib/format";
import { FillsTable } from "./fills-table";
import { LiveStore, type LiveSnapshot } from "./live-store";
import { equityCurve, maxDrawdownAt, portfolioAt } from "./model";
import { PriceChart } from "./price-chart";
import { ChartViewBar, useChartView } from "./controls/chart-view";
import { LiveControls } from "./controls/live-controls";
import { useLiveControls } from "./controls/use-live-controls";

const POLL_MS = 3000;
const NO_BREAKS: number[] = [];
const close = (c: Candle) => ({ ts: c.ts, value: c.close });

export default function Dashboard() {
  const theme = useChartTheme();
  const [store] = useState(() => new LiveStore());
  const [data, setData] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const query = store.query();
        const res = await fetch(`/api/data${query}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status !== 304) {
          const json = await res.json();
          if (cancelled) return;
          if (!res.ok) throw new Error(json.error ?? res.statusText);
          const snapshot = store.apply(json as LivePayload, query);
          if (snapshot) setData(snapshot);
        }
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        busy = false;
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [store]);

  const range = data?.range ?? null;
  const controls = useLiveControls(range);
  const { t, live, showBidAsk, showFills } = controls;
  const scoreView = useChartView("score", range);
  const equityView = useChartView("equity", range, Infinity);

  const curve = useMemo(() => (data ? equityCurve(data) : null), [data]);
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

  if (!data || !curve) {
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
  const threshold = data.config.signalThreshold;
  const maxDrawdown = maxDrawdownAt(curve, t);
  const currentMarketStart = data.markets.at(-1)?.start ?? range.min;
  const yesPosition = portfolio.positions[data.tokens.yes] ?? 0;
  const noPosition = portfolio.positions[data.tokens.no] ?? 0;

  const yes = data.sides[0].points;
  const scoreSeries: ChartSeries[] = [
    {
      id: "score",
      label: "señal",
      type: "line",
      color: theme.accent,
      lineWidth: 2,
      data: candleSeries(yes.ts, yes.score, scoreView.interval, data.breaks).pointsUpTo(t, "close", close),
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
      data: candleSeries(curve.ts, curve.equity, equityView.interval, NO_BREAKS).pointsUpTo(t, "close", close),
    },
    {
      id: "drawdown",
      label: "drawdown",
      type: "area",
      pane: 1,
      color: theme.down,
      lineWidth: 1,
      data: candleSeries(curve.ts, curve.drawdown, equityView.interval, NO_BREAKS).pointsUpTo(t, "close", close),
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
        <Kpi label="Fills" icon={ArrowLeftRight} value={fmtInt(portfolio.fills)} />
      </KpiGrid>

      <ChartGroup edge={t}>
        <div className="grid gap-4 md:gap-6">
          {data.sides.map((side) => (
            <PriceChart
              key={side.label}
              side={side}
              color={side.label === "YES" ? theme.up : theme.down}
              t={t}
              range={range}
              live={live}
              showFills={showFills}
              breaks={data.breaks}
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

      <Panel title="Fills" actions={<ToneBadge>{fmtInt(portfolio.fills)}</ToneBadge>}>
        <FillsTable fills={data.fills} count={portfolio.fills} tokens={data.tokens} />
      </Panel>
    </Page>
  );
}
