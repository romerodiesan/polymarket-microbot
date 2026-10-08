export const fmtTime = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString("es", { hour12: false });
export const fmtDateTime = (ts: number) =>
  new Date(ts * 1000).toLocaleString("es", { hour12: false, dateStyle: "short", timeStyle: "medium" });
export const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
export const fmtPrice = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "—");
export const fmtNum = (n: number, digits = 4) => (Number.isFinite(n) ? n.toFixed(digits) : "—");

/** Fixed decimals with thousands separators; never renders "-0.00". */
export function fmtFixed(n: number, digits: number) {
  if (!Number.isFinite(n)) return "—";
  const rounded = Number(n.toFixed(digits)) + 0;
  return rounded.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Decimals adapted to magnitude: 249,037 · 12.35 · 0.0553. */
export function fmtSmart(n: number) {
  const abs = Math.abs(n);
  return fmtFixed(n, abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 4);
}

export const fmtInt = (n: number) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—");

export function fmtDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function PageHeader({ title, subtitle, children }: {
  title: string;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-zinc-400">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-3 text-sm">{children}</div>}
    </header>
  );
}

export function Card({ title, children, actions }: {
  title: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-white/[.03] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="text-sm font-semibold text-zinc-200">{title}</h2>
        {actions}
      </div>
      {children}
    </div>
  );
}

export function Kpi({ label, value, tone, hint }: {
  label: string;
  value: string;
  tone?: "up" | "down";
  hint?: string;
}) {
  const color = tone === "up" ? "text-emerald-400" : tone === "down" ? "text-red-400" : "text-zinc-100";
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-white/[.03] p-3">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className={`mt-1 truncate font-mono text-lg tabular-nums ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

export function Notice({ children, tone }: { children: React.ReactNode; tone?: "error" | "warn" }) {
  const styles =
    tone === "error"
      ? "border-red-500/40 bg-red-500/10 text-red-200"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
        : "border-white/10 bg-white/[.03] text-zinc-300";
  return <div className={`rounded-xl border p-4 text-sm ${styles}`}>{children}</div>;
}

export function Page({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 md:p-6">{children}</main>;
}

export const axisProps = { stroke: "#a1a1aa", fontSize: 11 } as const;
export const gridStroke = "#ffffff14";

const BADGE_TONES = {
  neutral: "bg-white/10 text-zinc-300",
  green: "bg-emerald-500/15 text-emerald-300",
  red: "bg-red-500/15 text-red-300",
  sky: "bg-sky-500/15 text-sky-300",
  amber: "bg-amber-500/15 text-amber-300",
  violet: "bg-violet-500/15 text-violet-300",
} as const;

export function Badge({ tone = "neutral", children }: {
  tone?: keyof typeof BADGE_TONES;
  children: React.ReactNode;
}) {
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${BADGE_TONES[tone]}`}>
      {children}
    </span>
  );
}

export function TokenBadge({ label }: { label: string }) {
  return <Badge tone={label === "YES" ? "green" : label === "NO" ? "red" : "neutral"}>{label}</Badge>;
}

/** Number coloured by sign; values within `epsilon` of zero stay neutral. */
export function Signed({ value, format = fmtSmart, epsilon = 1e-9 }: {
  value: number;
  format?: (n: number) => string;
  epsilon?: number;
}) {
  const color = value > epsilon ? "text-emerald-400" : value < -epsilon ? "text-red-400" : "text-zinc-400";
  return <span className={color}>{format(value)}</span>;
}

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Right-aligned, monospaced, tabular digits. */
  numeric?: boolean;
  /** Tooltip on the header, e.g. to explain the metric. */
  hint?: string;
  className?: string;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty = "Sin datos.",
  maxHeight,
  stickyFirstColumn = true,
  onRowClick,
  selectedKey,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  empty?: React.ReactNode;
  maxHeight?: number;
  stickyFirstColumn?: boolean;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
}) {
  if (!rows.length) {
    return (
      <div className="rounded-lg border border-dashed border-white/10 px-4 py-8 text-center text-sm text-zinc-400">
        {empty}
      </div>
    );
  }
  // Opaque backgrounds so the sticky header/column hide content scrolling beneath them.
  const stickyCell = "sticky left-0 z-[1] shadow-[1px_0_0_0_rgba(255,255,255,0.08)]";
  return (
    <div
      className="overflow-auto overscroll-x-contain rounded-lg border border-white/10"
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table className="w-full min-w-max border-separate border-spacing-0 text-left text-sm">
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th
                key={col.key}
                scope="col"
                title={col.hint}
                className={[
                  "sticky top-0 z-[2] whitespace-nowrap border-b border-white/10 bg-[#18181b] px-3 py-2",
                  "text-[11px] font-medium uppercase tracking-wide text-zinc-400",
                  col.numeric ? "text-right" : "",
                  col.hint ? "cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-4" : "",
                  i === 0 && stickyFirstColumn ? `${stickyCell} z-[3]` : "",
                ].join(" ")}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => {
            const key = rowKey(row, r);
            const selected = selectedKey === key;
            const rowBg = selected ? "bg-[#1f1f24]" : "bg-[#111113] group-hover:bg-[#17171b]";
            return (
              <tr
                key={key}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
                aria-selected={onRowClick ? selected : undefined}
                className={`group ${onRowClick ? "cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500" : ""}`}
              >
                {columns.map((col, i) => (
                  <td
                    key={col.key}
                    className={[
                      "whitespace-nowrap border-b border-white/5 px-3 py-2 group-last:border-b-0",
                      rowBg,
                      col.numeric ? "text-right font-mono tabular-nums" : "",
                      i === 0 && stickyFirstColumn ? stickyCell : "",
                      col.className ?? "",
                    ].join(" ")}
                  >
                    {col.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
