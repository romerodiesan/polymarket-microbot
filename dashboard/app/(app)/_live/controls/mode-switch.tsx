"use client";

import { History } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

const ITEM_CLASS = "h-8 gap-1.5 rounded-md px-2.5 text-xs font-medium data-[state=on]:bg-background data-[state=on]:shadow-sm";

export function ModeSwitch({ live, speed, playing, onLive, onReplay, className }: {
  live: boolean;
  speed: number;
  playing: boolean;
  onLive: () => void;
  onReplay: () => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      spacing={1}
      aria-label="Modo"
      value={live ? "live" : "replay"}
      onValueChange={(v) => (v === "live" ? onLive() : v === "replay" ? onReplay() : undefined)}
      className={cn("rounded-lg bg-muted p-0.5", className)}
    >
      <ToggleGroupItem value="live" className={cn(ITEM_CLASS, "data-[state=on]:text-emerald-600 dark:data-[state=on]:text-emerald-400")}>
        <span className="relative flex size-2">
          {live && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />}
          <span className={cn("relative inline-flex size-2 rounded-full", live ? "bg-emerald-500" : "bg-muted-foreground/50")} />
        </span>
        En vivo
      </ToggleGroupItem>
      <ToggleGroupItem value="replay" className={cn(ITEM_CLASS, "data-[state=on]:text-sky-600 dark:data-[state=on]:text-sky-400")}>
        <History />
        Repetición
        {!live && (
          <span
            className={cn(
              "rounded bg-sky-500/15 px-1 font-mono text-[10px] tabular-nums text-sky-700 dark:text-sky-300",
              !playing && "opacity-60",
            )}
          >
            {speed}x
          </span>
        )}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
