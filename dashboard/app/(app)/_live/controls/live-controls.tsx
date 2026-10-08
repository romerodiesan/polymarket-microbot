"use client";

import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { ChartTheme } from "@/components/charts/theme";
import { ModeSwitch } from "./mode-switch";
import { ShortcutsHelp } from "./shortcuts-help";
import { type TimelineMark, Timeline } from "./timeline";
import { PlayButton, SpeedChoice, StepButtons, Transport } from "./transport";
import type { LiveControlsState } from "./use-live-controls";
import { useLiveShortcuts } from "./use-live-shortcuts";
import { LayerSwitches, LayersPopover } from "./view-controls";

type Props = {
  c: LiveControlsState;
  markets: number[];
  fills: TimelineMark[];
  theme: ChartTheme;
};

const GLASS = "bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70";

function ViewSheet({ c }: { c: LiveControlsState }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 px-2.5 text-xs">
          <SlidersHorizontal />
          Vista
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="rounded-t-xl">
        <SheetHeader>
          <SheetTitle>Vista</SheetTitle>
          <SheetDescription>Capas de precio y velocidad de repetición. Rango y velas se eligen en cada gráfica.</SheetDescription>
        </SheetHeader>
        <div className="grid gap-6 px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
          <section className="grid gap-3">
            <h3 className="text-sm font-medium">Capas</h3>
            <LayerSwitches c={c} />
          </section>
          <section className="grid gap-2">
            <h3 className="text-sm font-medium">Velocidad de repetición</h3>
            <SpeedChoice c={c} />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function LiveControls({ c, markets, fills, theme }: Props) {
  const [helpOpen, setHelpOpen] = useState(false);
  useLiveShortcuts(c, () => setHelpOpen((o) => !o));
  const mode = <ModeSwitch live={c.live} speed={c.speed} playing={c.playing} onLive={c.goLive} onReplay={c.enterReplay} />;

  return (
    <>
      <section
        aria-label="Controles de reproducción"
        className={`sticky top-14 z-20 hidden rounded-xl border px-4 py-3 shadow-sm md:block ${GLASS}`}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {mode}
          <Separator orientation="vertical" className="h-6! max-lg:hidden" />
          <Transport c={c} />
          <div className="ml-auto flex items-center gap-2">
            <LayersPopover c={c} />
            <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
          </div>
        </div>
        <Separator className="my-3" />
        <Timeline c={c} markets={markets} fills={fills} theme={theme} />
      </section>

      <section
        aria-label="Modo y capas"
        className={`sticky top-14 z-20 -mx-3 -mt-1 flex items-center justify-between gap-2 border-b px-3 py-2 sm:-mx-4 sm:px-4 md:hidden ${GLASS}`}
      >
        {mode}
        <LayersPopover c={c} />
      </section>

      <section
        aria-label="Reproductor"
        className={`fixed inset-x-0 bottom-0 z-30 border-t px-3 pt-1 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] shadow-[0_-4px_16px_-8px_rgb(0_0_0/0.25)] md:hidden ${GLASS}`}
      >
        <Timeline c={c} markets={markets} fills={fills} theme={theme} compact />
        <div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-center">
          <div>
            <ViewSheet c={c} />
          </div>
          <div className="flex items-center gap-1">
            <StepButtons c={c}>
              <PlayButton c={c} className="mx-2 size-10" />
            </StepButtons>
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              onClick={c.rotateSpeed}
              className="h-8 px-2.5 font-mono text-xs tabular-nums"
              aria-label={`Velocidad ${c.speed}x, cambiar`}
            >
              {c.speed}x
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
