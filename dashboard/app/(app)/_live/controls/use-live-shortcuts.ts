"use client";

import { useEffect, useRef } from "react";
import { KEY_STEP_LARGE_SECONDS, KEY_STEP_SECONDS } from "./options";
import type { LiveControlsState } from "./use-live-controls";

export const SHORTCUTS = [
  { keys: ["Espacio"], label: "Reproducir / pausar" },
  { keys: ["←", "→"], label: `Retroceder / avanzar ${KEY_STEP_SECONDS} s` },
  { keys: ["Shift", "←→"], label: `Saltar ${KEY_STEP_LARGE_SECONDS} s` },
  { keys: ["Inicio", "Fin"], label: "Ir al principio / al final" },
  { keys: ["L"], label: "Volver a en vivo" },
  { keys: ["R"], label: "Repetir desde el inicio" },
  { keys: ["[", "]"], label: "Bajar / subir velocidad" },
  { keys: ["B"], label: "Mostrar Bid/Ask" },
  { keys: ["F"], label: "Mostrar fills" },
  { keys: ["?"], label: "Mostrar esta ayuda" },
] as const;

/** Text fields and open overlays own every key. */
const KEY_OWNERS = "input, textarea, select, [contenteditable=true], [role=dialog], [role=menu], [role=listbox]";
/** Sliders and roving-focus groups own the navigation keys. */
const NAV_OWNERS = "[role=slider], [role=radiogroup], [role=group], [role=tablist]";
const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

export function useLiveShortcuts(controls: LiveControlsState, onHelp: () => void) {
  const ref = useRef({ controls, onHelp });
  useEffect(() => {
    ref.current = { controls, onHelp };
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Alt stays allowed: "[" and "]" need Option/AltGr on Spanish layouts.
      if (e.defaultPrevented || e.metaKey || e.ctrlKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(KEY_OWNERS)) return;
      if (NAV_KEYS.has(e.key) && target?.closest(NAV_OWNERS)) return;
      // Buttons already activate on Space/Enter.
      if (e.key === " " && target?.closest("button, a")) return;

      const { controls: c, onHelp: help } = ref.current;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const stepBy = e.shiftKey ? KEY_STEP_LARGE_SECONDS : KEY_STEP_SECONDS;
      const actions: Record<string, () => void> = {
        " ": c.togglePlay,
        ArrowLeft: () => c.step(-stepBy),
        ArrowRight: () => c.step(stepBy),
        Home: c.jumpStart,
        End: c.jumpEnd,
        l: c.goLive,
        r: c.startReplay,
        "[": () => c.cycleSpeed(-1),
        "]": () => c.cycleSpeed(1),
        b: () => c.setShowBidAsk(!c.showBidAsk),
        f: () => c.setShowFills(!c.showFills),
        "?": help,
      };
      const action = actions[key];
      if (!action) return;
      e.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
