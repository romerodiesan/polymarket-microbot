export const fmtTime = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString("es", { hour12: false });
export const fmtDateTime = (ts: number) =>
  new Date(ts * 1000).toLocaleString("es", { hour12: false, dateStyle: "short", timeStyle: "medium" });
export const fmtDay = (ts: number) => new Date(ts * 1000).toLocaleDateString("es", { day: "2-digit", month: "short" });
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

/** Player-style clock: m:ss, or h:mm:ss past an hour. */
export function fmtClock(seconds: number) {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function fmtBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
