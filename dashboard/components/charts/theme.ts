import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

const shared = {
  font: "var(--font-geist-mono), ui-monospace, monospace",
  fontSize: 11,
} as const;

const dark = {
  ...shared,
  mode: "dark" as "dark" | "light",
  text: "#a1a1aa",
  textStrong: "#e4e4e7",
  textMuted: "#71717a",
  grid: "rgba(255,255,255,0.05)",
  gridStrong: "rgba(255,255,255,0.08)",
  paneHover: "rgba(255,255,255,0.15)",
  crosshair: "rgba(255,255,255,0.3)",
  labelBg: "#27272a",
  zeroLine: "rgba(255,255,255,0.25)",
  cursorFill: "rgba(255,255,255,0.05)",
  separator: "rgba(250,204,21,0.35)",
  separatorText: "rgba(250,204,21,0.8)",
  up: "#22c55e",
  down: "#ef4444",
  bid: "#4ade80",
  ask: "#f87171",
  accent: "#38bdf8",
  violet: "#a78bfa",
  buy: "#22d3ee",
  sell: "#f97316",
};

export type ChartTheme = typeof dark;

const light: ChartTheme = {
  ...shared,
  mode: "light",
  text: "#52525b",
  textStrong: "#18181b",
  textMuted: "#a1a1aa",
  grid: "rgba(0,0,0,0.05)",
  gridStrong: "rgba(0,0,0,0.1)",
  paneHover: "rgba(0,0,0,0.2)",
  crosshair: "rgba(0,0,0,0.35)",
  labelBg: "#3f3f46",
  zeroLine: "rgba(0,0,0,0.3)",
  cursorFill: "rgba(0,0,0,0.04)",
  separator: "rgba(202,138,4,0.45)",
  separatorText: "rgba(161,98,7,0.95)",
  up: "#16a34a",
  down: "#dc2626",
  bid: "#22c55e",
  ask: "#ef4444",
  accent: "#0284c7",
  violet: "#7c3aed",
  buy: "#0891b2",
  sell: "#ea580c",
};

export const getChartTheme = (mode: "dark" | "light"): ChartTheme => (mode === "light" ? light : dark);

const subscribeNothing = () => () => {};

/** Palette for the resolved theme; dark until mounted so server and first client render agree. */
export function useChartTheme(): ChartTheme {
  const { resolvedTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribeNothing, () => true, () => false);
  return getChartTheme(mounted && resolvedTheme === "light" ? "light" : "dark");
}

/** `#rrggbb` plus alpha in [0, 1]. */
export const withAlpha = (hex: string, alpha: number) =>
  `${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
