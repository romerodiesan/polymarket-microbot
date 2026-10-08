import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function Kpi({ label, value, tone, hint, icon: Icon }: {
  label: string;
  value: string;
  tone?: "up" | "down";
  hint?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card className="min-w-0 gap-1 px-3 py-3 md:px-4">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{label}</span>
        {Icon && <Icon className="size-3.5 shrink-0" />}
      </div>
      <div
        className={cn(
          "truncate font-mono text-lg font-medium tabular-nums md:text-xl",
          tone === "up" && "text-up",
          tone === "down" && "text-down",
        )}
      >
        {value}
      </div>
      {hint && <div className="truncate text-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
}

export function KpiGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn("grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6", className)}>{children}</section>;
}
