/**
 * debug-log — a persistent, always-on diagnostic log for the main process.
 *
 * Cairn's agent loops previously logged only to `console.*`, which is invisible
 * in a packaged app (no attached terminal) and lost on restart. Diagnosing a
 * slow turn or an abnormal `turn/end` after the fact was therefore impossible.
 *
 * This module writes newline-delimited JSON to
 * `<userData>/logs/cairn-debug.log`, rotating to `.1` at {@link MAX_BYTES} and
 * keeping a single generation. Writes are appended through one lazily-created
 * `WriteStream`, so a log call is a buffered `write()` — cheap enough to leave
 * on permanently for turn-phase timings.
 *
 * Design constraints:
 *  - **Never throw.** A logging failure must not break a turn, so every entry
 *    point is wrapped and degrades to a no-op.
 *  - **No Electron import at module scope.** Tests and the MCP runtime load this
 *    outside Electron; the userData path is injected via {@link setDebugLogRoot}
 *    (main.ts) and falls back to `CAIRN_USER_DATA_DIR` / cwd.
 *  - **Mirror to console** so `npm run dev` behaves as before.
 */
import fs from "node:fs";
import path from "node:path";

/** Rotate once the active log passes this size. */
const MAX_BYTES = 8 * 1024 * 1024;

type Fields = Record<string, unknown>;

let logRoot: string | null = null;
let stream: fs.WriteStream | null = null;
let streamPath: string | null = null;
let bytesWritten = 0;
let disabled = false;

/**
 * Point the logger at `<root>/logs`. Called from main.ts once `app.getPath`
 * is available. Any already-open stream is closed so the next write reopens
 * under the new root.
 */
export function setDebugLogRoot(root: string): void {
  if (logRoot === root) return;
  logRoot = root;
  closeStream();
}

function resolveRoot(): string {
  return logRoot
    ?? process.env.CAIRN_USER_DATA_DIR
    ?? process.cwd();
}

function closeStream(): void {
  const current = stream;
  stream = null;
  streamPath = null;
  bytesWritten = 0;
  if (current) { try { current.end(); } catch { /* ignore */ } }
}

/** Return the resolved path of the active log file (for surfacing in the UI). */
export function getDebugLogPath(): string {
  return path.join(resolveRoot(), "logs", "cairn-debug.log");
}

function ensureStream(): fs.WriteStream | null {
  if (disabled) return null;
  const target = getDebugLogPath();
  if (stream && streamPath === target) {
    // Rotate when the current generation is full.
    if (bytesWritten < MAX_BYTES) return stream;
    closeStream();
    try { fs.renameSync(target, `${target}.1`); } catch { /* first rotation may race */ }
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Pre-seed the byte counter from the existing file so a restart does not
    // reset rotation accounting and let the log grow without bound.
    try { bytesWritten = fs.statSync(target).size; } catch { bytesWritten = 0; }
    if (bytesWritten >= MAX_BYTES) {
      try { fs.renameSync(target, `${target}.1`); } catch { /* ignore */ }
      bytesWritten = 0;
    }
    stream = fs.createWriteStream(target, { flags: "a" });
    // An EPIPE/EACCES on the log must never surface as an unhandled error.
    stream.on("error", () => { disabled = true; closeStream(); });
    streamPath = target;
    return stream;
  } catch {
    // Unwritable log dir (read-only volume, sandbox) — stop trying.
    disabled = true;
    return null;
  }
}

/**
 * Append one structured entry. `scope` groups related lines (e.g. "chat",
 * "cordis-coding"); `fields` is JSON-serialised with circular refs and Errors
 * flattened so a raw dsh event or failure object can be passed verbatim.
 */
export function dlog(scope: string, message: string, fields?: Fields): void {
  const line = { t: new Date().toISOString(), scope, message, ...(fields ?? {}) };
  // Console first so dev behaviour is unchanged even if the file write fails.
  const suffix = fields && Object.keys(fields).length ? ` ${safeStringify(fields)}` : "";
  console.log(`[${scope}] ${message}${suffix}`);
  try {
    const target = ensureStream();
    if (!target) return;
    const encoded = `${safeStringify(line)}\n`;
    bytesWritten += Buffer.byteLength(encoded);
    target.write(encoded);
  } catch { /* logging must never break a turn */ }
}

/**
 * JSON.stringify that tolerates the shapes we actually pass in: Errors (which
 * serialise to `{}` by default), circular graphs (dsh sessions/contexts), and
 * BigInt. Falls back to a marker string rather than throwing.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (val instanceof Error) {
        return { name: val.name, message: val.message, stack: val.stack, ...(val as unknown as Fields) };
      }
      if (typeof val === "bigint") return `${val}n`;
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    }) ?? "null";
  } catch {
    return '"[unserialisable]"';
  }
}

/**
 * A phase timer for one logical operation (e.g. a chat turn).
 *
 * `mark(label)` records the elapsed time since the previous mark, so the log
 * shows where the wall-clock actually went instead of one opaque total.
 * `end(label, fields)` emits the ordered breakdown plus the total.
 *
 * Always on: a turn produces a handful of `Date.now()` calls and one write,
 * which is immaterial next to a model request, and being always-on is the whole
 * point — the slow turn we need to explain is the one that already happened.
 */
export interface PhaseTimer {
  /** Record a completed phase, named for the work that just finished. */
  mark: (label: string) => void;
  /** Milliseconds since the timer started. */
  elapsed: () => number;
  /** Emit the full ordered breakdown. */
  end: (label: string, fields?: Fields) => void;
}

export function startPhaseTimer(scope: string, fields?: Fields): PhaseTimer {
  const t0 = Date.now();
  let last = t0;
  const phases: Array<[string, number]> = [];
  return {
    mark(label) {
      const now = Date.now();
      phases.push([label, now - last]);
      last = now;
    },
    elapsed() { return Date.now() - t0; },
    end(label, extra) {
      const total = Date.now() - t0;
      // Surface the dominant phase directly — it is the answer to "why was this
      // slow?" and saves reading the breakdown by eye in the common case.
      const slowest = phases.reduce<[string, number] | null>(
        (acc, p) => (acc === null || p[1] > acc[1] ? p : acc),
        null,
      );
      dlog(scope, label, {
        totalMs: total,
        ...(slowest ? { slowestPhase: slowest[0], slowestMs: slowest[1] } : {}),
        phases: Object.fromEntries(phases),
        ...(fields ?? {}),
        ...(extra ?? {}),
      });
    },
  };
}
