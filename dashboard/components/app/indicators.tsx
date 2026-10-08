import { Badge } from "@/components/ui/badge";
import { fmtSmart } from "@/lib/format";
import { cn } from "@/lib/utils";

const TONES = {
  neutral: "bg-muted text-muted-foreground",
  green: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  red: "bg-red-500/15 text-red-700 dark:text-red-300",
  sky: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  violet: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
} as const;

export type Tone = keyof typeof TONES;

export function ToneBadge({ tone = "neutral", children, className }: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return <Badge className={cn("rounded-md border-transparent", TONES[tone], className)}>{children}</Badge>;
}

export function TokenBadge({ label }: { label: string }) {
  return <ToneBadge tone={label === "YES" ? "green" : label === "NO" ? "red" : "neutral"}>{label}</ToneBadge>;
}

/** Number coloured by sign; values within `epsilon` of zero stay neutral. */
export function Signed({ value, format = fmtSmart, epsilon = 1e-9 }: {
  value: number;
  format?: (n: number) => string;
  epsilon?: number;
}) {
  const color = value > epsilon ? "text-up" : value < -epsilon ? "text-down" : "text-muted-foreground";
  return <span className={color}>{format(value)}</span>;
}

export function StatusDot({ active, className }: { active: boolean; className?: string }) {
  return (
    <span className={cn("relative flex size-2", className)}>
      {active && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
      <span className={cn("relative inline-flex size-2 rounded-full", active ? "bg-emerald-500" : "bg-muted-foreground/50")} />
    </span>
  );
}
