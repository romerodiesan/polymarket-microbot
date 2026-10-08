"use client";

import { useCallback, useEffect, useState } from "react";
import { useStoredState } from "@/hooks/use-stored-state";
import { SPEEDS } from "./options";

const TICK_MS = 100;
/** Leaving live replays from this far back. */
const REPLAY_LOOKBACK_SEC = 900;

export type TimeRange = { min: number; max: number };

type LivePrefs = { showBidAsk: boolean; showFills: boolean; speed: number };

const DEFAULT_PREFS: LivePrefs = { showBidAsk: true, showFills: true, speed: 10 };

const sanitizePrefs = (stored: Record<string, unknown>): LivePrefs => ({
  showBidAsk: typeof stored.showBidAsk === "boolean" ? stored.showBidAsk : DEFAULT_PREFS.showBidAsk,
  showFills: typeof stored.showFills === "boolean" ? stored.showFills : DEFAULT_PREFS.showFills,
  speed: SPEEDS.some((s) => s === stored.speed) ? (stored.speed as number) : DEFAULT_PREFS.speed,
});

/** Playback clock (live vs. replay cursor) plus persisted layer and speed preferences for the live page. */
export function useLiveControls(range: TimeRange | null) {
  const [prefs, updatePrefs] = useStoredState("microbot.live.prefs", DEFAULT_PREFS, sanitizePrefs);
  const [live, setLive] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(0);

  const min = range?.min ?? 0;
  const max = range?.max ?? 0;
  const clamp = useCallback((ts: number) => Math.min(Math.max(ts, min), max), [min, max]);
  const t = live ? max : clamp(cursor);
  const atEnd = !live && t >= max;

  useEffect(() => {
    if (live || !playing || !range) return;
    const id = setInterval(() => {
      setCursor((c) => {
        const next = c + (TICK_MS / 1000) * prefs.speed;
        if (next >= range.max) {
          setPlaying(false);
          return range.max;
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [live, playing, prefs.speed, range]);

  const replayFrom = useCallback(
    (ts: number, play: boolean) => {
      setLive(false);
      setCursor(clamp(ts));
      setPlaying(play);
    },
    [clamp],
  );

  const goLive = useCallback(() => {
    setLive(true);
    setPlaying(false);
  }, []);

  const enterReplay = useCallback(() => {
    if (live) replayFrom(max - REPLAY_LOOKBACK_SEC, false);
  }, [live, replayFrom, max]);

  const startReplay = useCallback(() => replayFrom(min, true), [replayFrom, min]);

  const togglePlay = useCallback(() => {
    if (live) replayFrom(max - REPLAY_LOOKBACK_SEC, true);
    else if (atEnd) replayFrom(min, true);
    else setPlaying((p) => !p);
  }, [live, atEnd, replayFrom, max, min]);

  const seek = useCallback(
    (ts: number) => {
      if (!live) setCursor(clamp(ts));
    },
    [live, clamp],
  );

  const step = useCallback(
    (seconds: number) => {
      if (live) {
        if (seconds < 0) replayFrom(max + seconds, false);
        return;
      }
      setCursor((c) => clamp(clamp(c) + seconds));
    },
    [live, max, clamp, replayFrom],
  );

  const jumpStart = useCallback(() => replayFrom(min, live ? false : playing), [replayFrom, min, live, playing]);

  const jumpEnd = useCallback(() => {
    if (live) return;
    setCursor(max);
    setPlaying(false);
  }, [live, max]);

  const speedIndex = SPEEDS.indexOf(prefs.speed as (typeof SPEEDS)[number]);
  const setSpeed = useCallback((speed: number) => updatePrefs({ speed }), [updatePrefs]);
  const cycleSpeed = useCallback(
    (direction: 1 | -1) => updatePrefs({ speed: SPEEDS[Math.min(Math.max(speedIndex + direction, 0), SPEEDS.length - 1)] }),
    [updatePrefs, speedIndex],
  );
  /** Next speed, wrapping back to the slowest after the fastest. */
  const rotateSpeed = useCallback(
    () => updatePrefs({ speed: SPEEDS[(speedIndex + 1) % SPEEDS.length] }),
    [updatePrefs, speedIndex],
  );
  const setShowBidAsk = useCallback((showBidAsk: boolean) => updatePrefs({ showBidAsk }), [updatePrefs]);
  const setShowFills = useCallback((showFills: boolean) => updatePrefs({ showFills }), [updatePrefs]);

  return {
    ...prefs,
    live,
    playing,
    t,
    range: { min, max },
    atEnd,
    goLive,
    enterReplay,
    startReplay,
    togglePlay,
    seek,
    step,
    jumpStart,
    jumpEnd,
    setSpeed,
    cycleSpeed,
    rotateSpeed,
    setShowBidAsk,
    setShowFills,
  };
}

export type LiveControlsState = ReturnType<typeof useLiveControls>;
