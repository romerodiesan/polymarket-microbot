"use client";

import { useEffect, useState } from "react";
import type { BotStatus } from "@/lib/data";

const POLL_MS = 5000;
/** The bot exports every few seconds; a staler file means it stopped. */
const LIVE_EXPORT_SECONDS = 20;

export function useBotStatus() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/data?view=status", { cache: "no-store" });
        if (res.ok && !cancelled) setStatus(await res.json());
      } catch {
        // Keep the last known status; the next poll retries.
      }
      if (!cancelled) setNow(Date.now() / 1000);
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const lagSeconds = status?.exportedAt && now ? Math.max(0, now - status.exportedAt) : null;
  return {
    mode: status?.mode ?? null,
    lagSeconds,
    running: lagSeconds !== null && lagSeconds < LIVE_EXPORT_SECONDS,
  };
}
