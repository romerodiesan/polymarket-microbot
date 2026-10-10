import "server-only";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { type BookEventRow, type BookSnapshot, type Level, replayBook } from "./book-replay";
import { ROOT, parquetPaths, readEnvFile } from "./data";

/** `book.json` older than this is a stopped bot, not the live book. */
const LIVE_MAX_AGE_SECONDS = 5;
/** Full snapshots are stored at least this often per active token (main.FULL_SNAPSHOT_SECONDS + margin). */
const WINDOWS_SECONDS = [75, 900];
const DEPTH = 20;
const COLUMNS = ["recv_ts", "connection_id", "seq", "event_type", "token_id", "side", "price", "size", "is_delta", "market"];
const FILE = /^(\d{8}-\d{2})(?:-\d+)?\.parquet$/;

export type BookResponse = {
  source: "live" | "replay";
  /** Time the books describe. */
  ts: number;
  tokens: Record<string, BookSnapshot | null>;
};

type LiveFile = {
  ts: number;
  connection_id: number;
  tokens: Record<string, {
    market: string | null;
    outcome: string | null;
    tick_size: number | null;
    updated_at: number | null;
    bids: Level[];
    asks: Level[];
  }>;
};

function bookStatePath() {
  const value = readEnvFile().PM_BOOK_STATE_PATH;
  return path.resolve(/*turbopackIgnore: true*/ ROOT, value || "data/bot/book.json");
}

function readLive(): LiveFile | null {
  try {
    return JSON.parse(readFileSync(bookStatePath(), "utf8"));
  } catch {
    return null;
  }
}

const hourKey = (ts: number) => {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}`;
};

type BookFile = { path: string; hour: string; mtime: number; size: number };

/** Hourly files of `book_events`, oldest first, with their mtime and size. */
function listFiles(dir: string): BookFile[] {
  if (!existsSync(dir)) return [];
  const out: BookFile[] = [];
  for (const name of readdirSync(dir)) {
    const m = name.match(FILE);
    if (!m) continue;
    const file = path.join(dir, name);
    try {
      const { mtimeMs, size } = statSync(file);
      out.push({ path: file, hour: m[1], mtime: mtimeMs / 1000, size });
    } catch {
      // compacted away while listing
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function filesBetween(files: BookFile[], from: number, to: number): BookFile[] {
  const first = hourKey(from);
  const last = hourKey(to);
  return files.filter((f) => f.hour >= first && f.hour <= last);
}

const asNumber = (v: unknown) => (v == null ? null : Number(v));

/** Parquet footers by path, valid while the file's mtime and size are unchanged. */
const metadataCache = new Map<string, { key: string; metadata: Awaited<ReturnType<typeof parquetMetadataAsync>> }>();
const METADATA_CACHE_MAX = 256;

async function readEvents(files: BookFile[], tokens: string[], from: number, to: number): Promise<BookEventRow[]> {
  const rows: BookEventRow[] = [];
  for (const file of files) {
    let handle;
    try {
      handle = await open(file.path, "r");
    } catch {
      continue; // compacted away between listing and reading
    }
    try {
      const { size, mtimeMs } = await handle.stat();
      const buffer = {
        byteLength: size,
        async slice(start: number, end = size) {
          const bytes = Buffer.allocUnsafe(end - start);
          await handle.read(bytes, 0, bytes.length, start);
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        },
      };
      const cacheKey = `${mtimeMs}:${size}`;
      let metadata = metadataCache.get(file.path)?.key === cacheKey ? metadataCache.get(file.path)!.metadata : null;
      if (!metadata) {
        metadata = await parquetMetadataAsync(buffer);
        metadataCache.delete(file.path);
        if (metadataCache.size >= METADATA_CACHE_MAX) metadataCache.delete(metadataCache.keys().next().value!);
        metadataCache.set(file.path, { key: cacheKey, metadata });
      }
      const present = new Set(metadata.schema.map((s) => s.name));
      const objects = await parquetReadObjects({
        file: buffer,
        metadata,
        compressors,
        columns: COLUMNS.filter((c) => present.has(c)),
        // Row groups whose recv_ts statistics miss the window are skipped without reading.
        filter: { recv_ts: { $gte: from, $lte: to }, token_id: { $in: tokens } },
      });
      for (const o of objects) {
        rows.push({
          recv_ts: Number(o.recv_ts),
          connection_id: asNumber(o.connection_id),
          seq: asNumber(o.seq),
          event_type: (o.event_type as string) ?? null,
          token_id: (o.token_id as string) ?? null,
          side: (o.side as string) ?? null,
          price: asNumber(o.price),
          size: asNumber(o.size),
          is_delta: o.is_delta == null ? null : Boolean(o.is_delta),
          market: (o.market as string) ?? null,
        });
      }
    } finally {
      await handle.close();
    }
  }
  return rows;
}

const bookDir = () => path.join(parquetPaths(readEnvFile()).parquetDir, "book_events");

type Books = Record<string, BookSnapshot | null>;

/** Recent replays by tokens, time and the files they read; scrubbing back and forth reuses them. */
const replayCache = new Map<string, Books>();
const REPLAY_CACHE_MAX = 64;

/** Books of `tokens` at `t`, reconstructed from the recorded L2 events. */
export async function replayBooks(tokens: string[], t: number, files = listFiles(bookDir())): Promise<Books> {
  const widest = filesBetween(files, t - WINDOWS_SECONDS[WINDOWS_SECONDS.length - 1], t);
  const key = `${tokens.join(",")}@${t}@${widest.map((f) => `${f.path}:${f.mtime}:${f.size}`).join("|")}`;
  const cached = replayCache.get(key);
  if (cached) {
    replayCache.delete(key);
    replayCache.set(key, cached);
    return cached;
  }

  const out: Books = Object.fromEntries(tokens.map((tok) => [tok, null]));
  let missing = tokens;
  for (const window of WINDOWS_SECONDS) {
    if (!missing.length) break;
    const rows = await readEvents(filesBetween(files, t - window, t), missing, t - window, t);
    for (const token of missing) out[token] = replayBook(rows, token, t, DEPTH);
    missing = missing.filter((token) => !out[token]);
  }
  if (replayCache.size >= REPLAY_CACHE_MAX) replayCache.delete(replayCache.keys().next().value!);
  replayCache.set(key, out);
  return out;
}

/**
 * The live book from the bot's `book.json` when `t` is now (or omitted) and the file is fresh;
 * otherwise the book replayed from `book_events` at `t`.
 */
export async function loadBooks(tokens: string[], t: number | null): Promise<BookResponse> {
  const now = Date.now() / 1000;
  if (t === null || t >= now - LIVE_MAX_AGE_SECONDS) {
    const live = readLive();
    const wanted = tokens.length ? tokens : Object.keys(live?.tokens ?? {});
    if (live && now - live.ts <= LIVE_MAX_AGE_SECONDS && wanted.every((tok) => tok in live.tokens)) {
      return {
        source: "live",
        ts: live.ts,
        tokens: Object.fromEntries(
          wanted.map((tok) => {
            const b = live.tokens[tok];
            return [tok, {
              token: tok,
              market: b.market,
              outcome: b.outcome,
              tickSize: b.tick_size,
              bids: b.bids,
              asks: b.asks,
              updatedAt: b.updated_at,
            }];
          }),
        ),
      };
    }
  }
  const files = listFiles(bookDir());
  let at = t ?? now;
  // Nothing is recorded after the newest file was last written: replaying there instead of at
  // "now" gives the same book, and the same answer (cached) on every poll while the bot is stopped.
  const newest = files.reduce((max, f) => Math.max(max, f.mtime), -Infinity);
  if (Number.isFinite(newest) && at > newest) at = Math.floor(newest);
  return { source: "replay", ts: at, tokens: await replayBooks(tokens, at, files) };
}
