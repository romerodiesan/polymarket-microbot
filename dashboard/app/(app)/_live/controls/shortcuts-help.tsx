"use client";

import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SHORTCUTS } from "./use-live-shortcuts";

export function ShortcutsHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button size="icon" variant="ghost" className="size-8" aria-label="Atajos de teclado">
              <Keyboard />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          Atajos de teclado <Kbd>?</Kbd>
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">Atajos de teclado</p>
          <p className="text-xs text-muted-foreground">Funcionan en cualquier parte de esta página.</p>
        </div>
        <ul className="grid gap-2 px-4 py-3 text-sm">
          {SHORTCUTS.map((s) => (
            <li key={s.label} className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{s.label}</span>
              <KbdGroup>
                {s.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </KbdGroup>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
