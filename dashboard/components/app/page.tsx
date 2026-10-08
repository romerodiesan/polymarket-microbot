import { AlertCircle, Info, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-3 sm:p-4 md:gap-6 md:p-6", className)}>
      {children}
    </div>
  );
}

export function PageHeader({ title, description, children }: {
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2 text-sm">{children}</div>}
    </header>
  );
}

/** Card with a header row (title, optional description and actions) and padded content. */
export function Panel({ title, description, actions, children, className, contentClassName }: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Card className={cn("min-w-0 gap-4 py-4 md:py-5", className)}>
      <CardHeader className="px-4 md:px-5">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description && <CardDescription className="text-xs">{description}</CardDescription>}
        {actions && <CardAction className="flex items-center gap-2">{actions}</CardAction>}
      </CardHeader>
      <CardContent className={cn("min-w-0 px-4 md:px-5", contentClassName)}>{children}</CardContent>
    </Card>
  );
}

const NOTICE_ICONS = { info: Info, warn: TriangleAlert, error: AlertCircle } as const;

export function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: keyof typeof NOTICE_ICONS }) {
  const Icon = NOTICE_ICONS[tone];
  return (
    <Alert
      variant={tone === "error" ? "destructive" : "default"}
      className={tone === "warn" ? "border-amber-500/40 text-amber-700 dark:text-amber-300" : undefined}
    >
      <Icon />
      <AlertDescription className={tone === "info" ? undefined : "text-current"}>{children}</AlertDescription>
    </Alert>
  );
}

export function EmptyState({ icon: Icon, title, children }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

/** Placeholder layout while the first response loads. */
export function PageSkeleton({ kpis = 6, panels = 2 }: { kpis?: number; panels?: number }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: kpis }, (_, i) => <Skeleton key={i} className="h-[76px] rounded-xl" />)}
      </div>
      {Array.from({ length: panels }, (_, i) => <Skeleton key={i} className="h-72 rounded-xl" />)}
    </>
  );
}
