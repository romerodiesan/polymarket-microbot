"use client";

import { usePathname } from "next/navigation";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useBotStatus } from "@/hooks/use-bot-status";
import { StatusDot, ToneBadge } from "./indicators";
import { NAV_LINKS, isActiveLink } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";

export function Topbar() {
  const pathname = usePathname();
  const { mode, lagSeconds, running } = useBotStatus();
  const title = NAV_LINKS.find((l) => isActiveLink(l.href, pathname))?.label ?? "Microbot";

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 md:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <span className="truncate text-sm font-medium">{title}</span>
      <div className="ml-auto flex items-center gap-2">
        {mode && (
          <ToneBadge tone={mode === "live" ? "red" : "neutral"} className="font-mono uppercase">
            {mode}
          </ToneBadge>
        )}
        {lagSeconds !== null && (
          <span
            className="flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs"
            title={`Último export hace ${Math.round(lagSeconds)} s`}
          >
            <StatusDot active={running} />
            <span>{running ? "Activo" : "Detenido"}</span>
            <span className="hidden font-mono tabular-nums text-muted-foreground sm:inline">
              {Math.round(lagSeconds)}s
            </span>
          </span>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}
