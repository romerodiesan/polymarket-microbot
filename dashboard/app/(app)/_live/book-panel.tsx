"use client";

import { BookOpen } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { changedText, usePoll } from "@/hooks/use-poll";
import { ToneBadge, TokenBadge } from "@/components/app/indicators";
import { EmptyState, Notice, Panel } from "@/components/app/page";
import type { ChartTheme } from "@/components/charts/theme";
import { XYLines } from "@/components/charts/xy-lines";
import type { Level } from "@/lib/book-replay";
import type { BookResponse } from "@/lib/book";
import type { MarketSpan } from "@/lib/data";
import { fmtFixed, fmtPrice, fmtTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { type Fill, fillsAt } from "./live-store";

const LIVE_POLL_MS = 1000;
/** Polling while the bot isn't publishing and the book is replayed at the last recorded event. */
const STALE_POLL_MS = 5000;
/** While scrubbing or playing back, at most one request this often (the latest cursor wins). */
const REPLAY_THROTTLE_MS = 500;
const LADDER_LEVELS = 10;
/** Bot fills this close to the book's time are marked on its price level. */
const FILL_WINDOW_SECONDS = 60;

type Tokens = { yes: string; no: string };

function tokensAt(markets: MarketSpan[], fallback: Tokens, t: number): Tokens {
  let found: MarketSpan | undefined;
  for (const m of markets) {
    if (m.start > t) break;
    found = m;
  }
  return found?.yes && found.no ? { yes: found.yes, no: found.no } : fallback;
}

/** `value`, updated at most every `ms` and always ending on the latest one. */
function useThrottled<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const id = setTimeout(() => {
      last.current = Date.now();
      setOut(value);
    }, Math.max(0, last.current + ms - Date.now()));
    return () => clearTimeout(id);
  }, [value, ms]);
  return out;
}

function useBooks(yes: string, no: string, t: number, live: boolean) {
  const [data, setData] = useState<BookResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previous = useRef<string | null>(null);
  const key = `${yes},${no}`;
  // Whole seconds, so small cursor moves don't refetch.
  const replayAt = useThrottled(Math.floor(t), REPLAY_THROTTLE_MS);
  const at = live ? null : replayAt;
  const interval = live ? (data && data.source !== "live" ? STALE_POLL_MS : LIVE_POLL_MS) : null;

  usePoll(
    async (signal) => {
      if (!yes || !no) return;
      try {
        const query = new URLSearchParams({ tokens: key });
        if (at !== null) query.set("t", String(at));
        const res = await fetch(`/api/book?${query}`, { cache: "no-store", signal });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.error ?? res.statusText);
        }
        const text = await changedText(res, previous);
        if (signal.aborted) return;
        if (text !== null) setData(JSON.parse(text) as BookResponse);
        setError(null);
      } catch (e) {
        if (!signal.aborted) setError(e instanceof Error ? e.message : String(e));
      }
    },
    interval,
    [key, at],
  );

  return { data, error };
}

type Row = { price: number; size: number; total: number };

function cumulative(levels: Level[]): Row[] {
  let total = 0;
  return levels.map(([price, size]) => ({ price, size, total: (total += size) }));
}

const NO_FILLS: Fill[] = [];

/** Fills of `token` in (`t` − FILL_WINDOW_SECONDS, `t`], found by binary search over the sorted fills. */
function fillsNear(fills: Fill[], token: string, t: number): Fill[] {
  const end = fillsAt(fills, t);
  const start = fillsAt(fills, t - FILL_WINDOW_SECONDS);
  if (end === start) return NO_FILLS;
  const out = fills.slice(start, end).filter((f) => f.token_id === token);
  return out.length ? out : NO_FILLS;
}

const sameFills = (a: Fill[], b: Fill[]) => a.length === b.length && a.every((f, i) => f === b[i]);

const formatPrice = (v: number) => v.toFixed(2);
const formatSize = (v: number) => fmtFixed(v, 0);
const priceLabel = (x: number) => `Precio ${x.toFixed(3)}`;
const UNIT_DOMAIN: [number, number] = [0, 1];

const Ladder = memo(function Ladder({ label, bids, asks, fills, theme }: {
  label: "YES" | "NO";
  bids: Level[];
  asks: Level[];
  fills: Fill[];
  theme: ChartTheme;
}) {
  const bidRows = useMemo(() => cumulative(bids.slice(0, LADDER_LEVELS)), [bids]);
  const askRows = useMemo(() => cumulative(asks.slice(0, LADDER_LEVELS)), [asks]);
  const maxTotal = Math.max(bidRows.at(-1)?.total ?? 0, askRows.at(-1)?.total ?? 0, 1e-9);
  const bestBid = bids[0]?.[0];
  const bestAsk = asks[0]?.[0];
  const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : null;
  const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : null;
  const bidDepth = bidRows.slice(0, 5).reduce((s, r) => s + r.size, 0);
  const askDepth = askRows.slice(0, 5).reduce((s, r) => s + r.size, 0);
  const imbalance = bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : null;
  const filledAt = new Map<number, Fill>();
  for (const f of fills) filledAt.set(Math.round(f.price * 1000) / 1000, f);

  const row = (r: Row, side: "bid" | "ask") => {
    const fill = filledAt.get(Math.round(r.price * 1000) / 1000);
    return (
      <div key={`${side}-${r.price}`} className="relative grid grid-cols-3 gap-2 px-2 py-0.5 font-mono text-xs tabular-nums">
        <div
          className="absolute inset-y-0 right-0 opacity-15"
          style={{ width: `${(r.total / maxTotal) * 100}%`, background: side === "bid" ? theme.bid : theme.ask }}
        />
        <span className={cn("relative flex items-center gap-1", side === "bid" ? "text-up" : "text-down")}>
          {fmtPrice(r.price)}
          {fill && (
            <span
              title={`Fill del bot: ${fill.side === "BUY" ? "compra" : "venta"} ${fmtFixed(fill.size, 2)} a las ${fmtTime(fill.ts)}`}
              className="size-1.5 rounded-full"
              style={{ background: fill.side === "BUY" ? theme.buy : theme.sell }}
            />
          )}
        </span>
        <span className="relative text-right">{fmtFixed(r.size, 2)}</span>
        <span className="relative text-right text-muted-foreground">{fmtFixed(r.total, 2)}</span>
      </div>
    );
  };

  return (
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <TokenBadge label={label} />
        <span>
          mid <span className="font-mono text-foreground">{mid === null ? "—" : fmtFixed(mid, 4)}</span>
        </span>
        <span>
          spread <span className="font-mono text-foreground">{spread === null ? "—" : fmtFixed(spread, 3)}</span>
        </span>
        <span title="Desequilibrio de tamaño en los 5 mejores niveles (−1 a 1)">
          deseq. <span className="font-mono text-foreground">{imbalance === null ? "—" : fmtFixed(imbalance, 2)}</span>
        </span>
      </div>
      <div className="rounded-lg border">
        <div className="grid grid-cols-3 gap-2 border-b px-2 py-1 text-[11px] text-muted-foreground">
          <span>Precio</span>
          <span className="text-right">Tamaño</span>
          <span className="text-right">Acumulado</span>
        </div>
        {askRows.length ? [...askRows].reverse().map((r) => row(r, "ask")) : (
          <div className="px-2 py-1 text-xs text-muted-foreground">Sin asks</div>
        )}
        <div className="border-y bg-muted/40 px-2 py-0.5 text-center font-mono text-[11px] text-muted-foreground">
          {spread === null ? "—" : `spread ${fmtFixed(spread, 3)}`}
        </div>
        {bidRows.length ? bidRows.map((r) => row(r, "bid")) : (
          <div className="px-2 py-1 text-xs text-muted-foreground">Sin bids</div>
        )}
      </div>
    </div>
  );
});

const NO_LEVELS: Level[] = [];

const depth = (levels: Level[] | undefined) => cumulative(levels ?? NO_LEVELS).map((r) => ({ x: r.price, y: r.total }));

/** Fills near `t` for one token, keeping the previous array while its contents are unchanged. */
function useFillsNear(fills: Fill[], token: string, t: number): Fill[] {
  const next = fillsNear(fills, token, t);
  const [kept, setKept] = useState(next);
  if (kept !== next && !sameFills(kept, next)) {
    setKept(next);
    return next;
  }
  return kept;
}

/** L2 ladders and cumulative depth of both tokens: live from the bot, or replayed at the cursor. */
export function BookPanel({ t, live, markets, tokens, fills, theme }: {
  t: number;
  live: boolean;
  markets: MarketSpan[];
  tokens: Tokens;
  fills: Fill[];
  theme: ChartTheme;
}) {
  const at = tokensAt(markets, tokens, t);
  const { data, error } = useBooks(at.yes, at.no, t, live);
  const yes = data?.tokens[at.yes] ?? null;
  const no = data?.tokens[at.no] ?? null;
  const bookTs = data?.ts ?? t;
  const yesFills = useFillsNear(fills, at.yes, bookTs);
  const noFills = useFillsNear(fills, at.no, bookTs);

  const depthSeries = useMemo(
    () => [
      { id: "yesBids", label: "YES bids", color: theme.bid, step: true, points: depth(yes?.bids).reverse() },
      { id: "yesAsks", label: "YES asks", color: theme.ask, step: true, points: depth(yes?.asks) },
      { id: "noBids", label: "NO bids", color: theme.bid, step: true, dashed: true, points: depth(no?.bids).reverse() },
      { id: "noAsks", label: "NO asks", color: theme.ask, step: true, dashed: true, points: depth(no?.asks) },
    ],
    [yes, no, theme],
  );

  return (
    <Panel
      title="Libro L2"
      description={
        data
          ? data.source === "live"
            ? "En vivo desde el bot (se actualiza cada segundo)"
            : `Reconstruido a las ${fmtTime(data.ts)} desde los eventos grabados`
          : "Mejores niveles de cada token"
      }
      actions={data && <ToneBadge tone={data.source === "live" ? "green" : "sky"}>{data.source === "live" ? "en vivo" : "replay"}</ToneBadge>}
    >
      {error && <Notice tone="warn">No se pudo cargar el libro: {error}</Notice>}
      {data && !yes && !no ? (
        <EmptyState icon={BookOpen} title="Sin libro en este momento">
          {data.source === "replay"
            ? "No hay una snapshot completa grabada en los 15 minutos anteriores (activa PM_RECORD_BOOK_EVENTS o elige otro momento)."
            : "El bot no está publicando el libro."}
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:gap-6">
          <div className="grid gap-4 md:grid-cols-2">
            <Ladder label="YES" bids={yes?.bids ?? NO_LEVELS} asks={yes?.asks ?? NO_LEVELS} fills={yesFills} theme={theme} />
            <Ladder label="NO" bids={no?.bids ?? NO_LEVELS} asks={no?.asks ?? NO_LEVELS} fills={noFills} theme={theme} />
          </div>
          <XYLines
            height={200}
            series={depthSeries}
            xDomain={UNIT_DOMAIN}
            formatX={formatPrice}
            formatY={formatSize}
            xLabel={priceLabel}
          />
        </div>
      )}
    </Panel>
  );
}
