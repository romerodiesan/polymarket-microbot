"use client";

import { useEffect, useRef } from "react";

/**
 * Runs `load` now and then every `intervalMs` after the previous call settles (never overlapping),
 * only while the tab is visible: hidden tabs stop polling and catch up as soon as they are shown.
 * The signal is aborted when the effect is torn down, so late responses are dropped.
 * `intervalMs` null loads once without polling.
 */
export function usePoll(load: (signal: AbortSignal) => Promise<void> | void, intervalMs: number | null, deps: unknown[]) {
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let lastRun = 0;

    const run = async () => {
      if (running || controller.signal.aborted) return;
      clearTimeout(timer);
      timer = undefined;
      running = true;
      lastRun = Date.now();
      try {
        await loadRef.current(controller.signal);
      } catch {
        // Each caller reports its own errors; a failed poll just waits for the next one.
      } finally {
        running = false;
      }
      schedule();
    };

    const schedule = () => {
      if (intervalMs === null || controller.signal.aborted || document.hidden) return;
      timer = setTimeout(run, Math.max(0, intervalMs - (Date.now() - lastRun)));
    };

    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = undefined;
      } else if (!running && timer === undefined && intervalMs !== null) {
        schedule();
      }
    };

    run();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);
}

/** Response body as text unless it equals `previous` (then null), to skip re-rendering unchanged data. */
export async function changedText(res: Response, previous: { current: string | null }): Promise<string | null> {
  const text = await res.text();
  if (text === previous.current) return null;
  previous.current = text;
  return text;
}
