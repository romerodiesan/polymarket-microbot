export const SPEEDS = [1, 10, 60, 300] as const;
export const RANGES = [
  { value: 300, label: "5m" },
  { value: 900, label: "15m" },
  { value: 3600, label: "1h" },
  { value: Infinity, label: "Todo" },
] as const;
export const CANDLE_SECONDS = [1, 5, 15, 60, 300] as const;
export const INTERVALS = [
  { value: 0, label: "Auto" },
  { value: 1, label: "1s" },
  { value: 5, label: "5s" },
  { value: 15, label: "15s" },
  { value: 60, label: "1m" },
  { value: 300, label: "5m" },
] as const;

export const STEP_SECONDS = 10;
export const KEY_STEP_SECONDS = 5;
export const KEY_STEP_LARGE_SECONDS = 30;

export const intervalLabel = (seconds: number) =>
  INTERVALS.find((i) => i.value === seconds)?.label ?? `${seconds}s`;
