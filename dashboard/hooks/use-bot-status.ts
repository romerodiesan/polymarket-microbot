"use client";

import { useCallback, useRef, useState } from "react";
import type { BotOverview } from "@/lib/bot";
import { changedText, usePoll } from "./use-poll";

const POLL_MS = 5000;
const FAST_POLL_MS = 1500;

export type BotAction = "start" | "stop";

/** Bot process status from /api/bot, polled faster while it is stopping, plus start/stop actions. */
export function useBotStatus({ withLog = false } = {}) {
  const [status, setStatus] = useState<BotOverview | null>(null);
  const [now, setNow] = useState(0);
  const [pending, setPending] = useState<BotAction | null>(null);

  const previous = useRef<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`/api/bot${withLog ? "?log" : ""}`, { cache: "no-store", signal });
      if (res.ok) {
        const text = await changedText(res, previous);
        if (text !== null && !signal?.aborted) setStatus(JSON.parse(text));
      }
    } catch {
      // Keep the last known status; the next poll retries.
    }
    if (!signal?.aborted) setNow(Date.now() / 1000);
  }, [withLog]);

  const stopping = status?.process.stopping ?? false;
  usePoll(load, stopping ? FAST_POLL_MS : POLL_MS, [load]);

  const act = useCallback(async (action: BotAction) => {
    setPending(action);
    try {
      const res = await fetch("/api/bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      previous.current = null;
      setStatus(json);
      setNow(Date.now() / 1000);
    } finally {
      setPending(null);
    }
  }, []);

  const lagSeconds = status?.exportedAt && now ? Math.max(0, now - status.exportedAt) : null;
  const uptimeSeconds = status?.process.startedAt && now ? Math.max(0, now - status.process.startedAt) : null;
  const lastExit = status?.process.lastExit;
  const sinceExitSeconds = lastExit && now ? Math.max(0, now - lastExit.endedAt) : null;
  return {
    status,
    mode: status?.mode ?? null,
    running: status?.process.running ?? false,
    stopping,
    pending,
    lagSeconds,
    uptimeSeconds,
    sinceExitSeconds,
    start: () => act("start"),
    stop: () => act("stop"),
    refresh: () => load(),
  };
}
