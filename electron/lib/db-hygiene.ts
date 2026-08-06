/**
 * Cairn — SQLite file-size hygiene.
 *
 * SQLite never shrinks the DB file on DELETE/UPDATE when auto_vacuum is off
 * (the default): freed pages accumulate on the freelist, so the file grows to
 * the high-water mark of churn — embedding reindexes, compactions, cleared
 * chat/session history — and stays there until a VACUUM.
 *
 * This module switches the DB to INCREMENTAL auto-vacuum (one-time, in the
 * background) and then reclaims free space cheaply with
 * `PRAGMA incremental_vacuum`, which moves tail freelist pages and truncates
 * the file without the full rewrite/lock of a VACUUM.
 *
 *   - `materializeIncrementalVacuum` — `PRAGMA auto_vacuum = INCREMENTAL`
 *     doesn't take effect on an existing database until it's VACUUMed, so this
 *     does exactly that once per DB (skips when already materialised).
 *   - `runStartupHygiene` — materialises the mode in the background after
 *     boot, and starts a periodic incremental reclaim when the file is bloated.
 *   - `reclaimFreeSpace` / `reclaimAfterReindex` — drain the freelist after
 *     bulk churn (embedding reindexes). Near-instant, safe to call anytime.
 *
 * All operations are best-effort and wrapped: hygiene must never disturb a
 * chat/agent turn or throw into an IPC handler.
 */

import type Database from "better-sqlite3";

const STARTUP_DELAY_MS = 45_000;
const PERIODIC_MS = 5 * 60_000;
/** Free-page ratio above which the periodic incremental reclaim fires. */
const PERIODIC_RATIO = 0.25;

let activeDb: Database.Database | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let periodicTimer: ReturnType<typeof setInterval> | null = null;

/** Fraction of the DB file currently made up of free (reclaimable) pages. */
export function freePageRatio(db: Database.Database): number {
  const pages = db.pragma("page_count", { simple: true }) as number;
  const free = db.pragma("freelist_count", { simple: true }) as number;
  if (!pages || pages <= 0) return 0;
  return free / pages;
}

/**
 * Enable INCREMENTAL auto-vacuum. On a database that already has content the
 * pragma is inert until a VACUUM rebuilds the file, so this runs the one-time
 * VACUUM when needed. Returns true when it materialised the mode, false when it
 * was already active or the vacuum was deferred (busy).
 */
export function materializeIncrementalVacuum(db: Database.Database): boolean {
  try {
    const mode = db.pragma("auto_vacuum", { simple: true }) as number;
    if (mode === 2) return false;
    db.pragma("auto_vacuum = INCREMENTAL");
    db.exec("VACUUM");
    return true;
  } catch {
    return false;
  }
}

/**
 * Drain free pages via incremental vacuum. Cheap (moves/truncates tail pages,
 * not a full rewrite) and safe to call at any point — a no-op, or a swallowed
 * error, when the mode isn't materialised yet or the DB is busy.
 */
export function reclaimFreeSpace(db: Database.Database): void {
  try {
    db.pragma("incremental_vacuum");
  } catch {
    // busy / not materialised — never let hygiene throw into the caller.
  }
}

/** Reclaim after a bulk operation that frees many pages (embedding reindexes). */
export function reclaimAfterReindex(db: Database.Database): void {
  reclaimFreeSpace(db);
}

/**
 * Start the startup + periodic hygiene. Idempotent; call again with a new DB
 * handle (workspace switch) and the timers re-arm for it. The one-time
 * materialisation VACUUM runs in the background after boot so it never blocks
 * the splash or first interaction; a busy DB defers to the next app start.
 */
export function runStartupHygiene(db: Database.Database): void {
  activeDb = db;

  if (startupTimer) clearTimeout(startupTimer);
  if (periodicTimer) clearInterval(periodicTimer);

  // Materialise incremental mode once per DB (requires a one-time VACUUM on
  // existing databases).
  startupTimer = setTimeout(() => {
    if (!activeDb) return;
    if (materializeIncrementalVacuum(activeDb)) {
      console.log("[db-hygiene] enabled incremental auto-vacuum (one-time VACUUM)");
    }
  }, STARTUP_DELAY_MS);
  if (typeof startupTimer.unref === "function") startupTimer.unref();

  // Cheap periodic reclaim keeps the file close to its live size after churn.
  periodicTimer = setInterval(() => {
    if (activeDb && freePageRatio(activeDb) > PERIODIC_RATIO) reclaimFreeSpace(activeDb);
  }, PERIODIC_MS);
  if (typeof periodicTimer.unref === "function") periodicTimer.unref();
}
