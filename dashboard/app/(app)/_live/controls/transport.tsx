"use client";

import { FastForward, Pause, Play, Rewind, RotateCcw, SkipBack, SkipForward, type LucideIcon } from "lucide-react";
import { ChoiceGroup } from "@/components/app/choice-group";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SPEEDS, STEP_SECONDS } from "./options";
import type { LiveControlsState } from "./use-live-controls";

const SPEED_OPTIONS = SPEEDS.map((s) => ({ value: s as number, label: `${s}x` }));

function Action({ icon: Icon, label, shortcut, onClick, disabled, dimmed, className, children }: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  /** Looks inactive (live mode) but still clickable: clicking enters replay. */
  dimmed?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={cn("size-8", dimmed && "text-muted-foreground", className)}
        >
          <Icon />
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <Kbd className="ml-1.5 hidden md:inline-flex">{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

export function PlayButton({ c, className }: { c: LiveControlsState; className?: string }) {
  const playing = !c.live && c.playing;
  const label = c.atEnd ? "Repetir" : playing ? "Pausar" : "Reproducir";
  const Icon = c.atEnd ? RotateCcw : playing ? Pause : Play;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" onClick={c.togglePlay} aria-label={label} className={cn("size-9 rounded-full", className)}>
          <Icon className={cn(!playing && !c.atEnd && "translate-x-px", "fill-current")} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        <Kbd className="ml-1.5 hidden md:inline-flex">Espacio</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/** Back/forward step buttons around the play button; shared by the desktop bar and the mobile player. */
export function StepButtons({ c, children }: { c: LiveControlsState; children: React.ReactNode }) {
  return (
    <>
      <Action icon={Rewind} label={`Retroceder ${STEP_SECONDS} s`} shortcut="←" dimmed={c.live} onClick={() => c.step(-STEP_SECONDS)} />
      {children}
      <Action icon={FastForward} label={`Avanzar ${STEP_SECONDS} s`} shortcut="→" disabled={c.live || c.atEnd} onClick={() => c.step(STEP_SECONDS)} />
    </>
  );
}

export function SpeedChoice({ c, className }: { c: LiveControlsState; className?: string }) {
  return <ChoiceGroup label="Velocidad de reproducción" options={SPEED_OPTIONS} value={c.speed} onChange={c.setSpeed} className={className} />;
}

export function Transport({ c }: { c: LiveControlsState }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-0.5">
        <Action icon={SkipBack} label="Ir al principio" shortcut="Inicio" dimmed={c.live} onClick={c.jumpStart} />
        <StepButtons c={c}>
          <PlayButton c={c} className="mx-1" />
        </StepButtons>
        <Action icon={SkipForward} label="Ir al final" shortcut="Fin" disabled={c.live || c.atEnd} onClick={c.jumpEnd} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Velocidad</span>
        <SpeedChoice c={c} />
      </div>
    </div>
  );
}
