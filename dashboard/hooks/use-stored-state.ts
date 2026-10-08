"use client";

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Map<string, Set<() => void>>();
const cache = new Map<string, { raw: string | null; value: unknown }>();

function read<T>(key: string, defaults: T, sanitize: (stored: Record<string, unknown>) => T): T {
  const raw = window.localStorage.getItem(key);
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value as T;
  let value = defaults;
  if (raw) {
    try {
      value = sanitize(JSON.parse(raw));
    } catch {
      value = defaults;
    }
  }
  cache.set(key, { raw, value });
  return value;
}

/**
 * Object state persisted in localStorage and shared by every hook using the same key.
 * `defaults` and `sanitize` must be stable (module-level). JSON turns Infinity into null; `sanitize` restores it.
 */
export function useStoredState<T extends object>(
  key: string,
  defaults: T,
  sanitize: (stored: Record<string, unknown>) => T,
): [T, (patch: Partial<T>) => void] {
  const subscribe = useCallback(
    (listener: () => void) => {
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      const onStorage = (e: StorageEvent) => e.key === key && listener();
      window.addEventListener("storage", onStorage);
      return () => {
        set.delete(listener);
        window.removeEventListener("storage", onStorage);
      };
    },
    [key],
  );
  const value = useSyncExternalStore(
    subscribe,
    () => read(key, defaults, sanitize),
    () => defaults,
  );
  const update = useCallback(
    (patch: Partial<T>) => {
      const next = { ...read(key, defaults, sanitize), ...patch };
      window.localStorage.setItem(key, JSON.stringify(next));
      listeners.get(key)?.forEach((l) => l());
    },
    [key, defaults, sanitize],
  );
  return [value, update];
}
