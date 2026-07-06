/**
 * Auto-sync controller — the single owner of "when do we sync".
 *
 * Foreground auto-sync (mirrors the desktop drain/sync loop, adapted to iOS):
 *   - on app launch (initialized from the root layout),
 *   - when the app returns to the foreground (AppState "active"),
 *   - on a light interval while active,
 *   - debounced shortly after a local write (create/edit/move).
 *
 * It is the only place syncNow() is scheduled automatically; the Sync tab /
 * header badge can still call requestSync() for a manual override. Background
 * (app-closed) sync is intentionally out of scope — iOS only grants best-effort
 * wakeups and iCloud propagates files on its own schedule anyway.
 *
 * State + a data-changed signal are exposed via a tiny pub/sub so screens can
 * re-hydrate when inbound peer changes land, and a global banner can surface
 * unresolved conflicts.
 */

import { AppState, type AppStateStatus } from "react-native";
import { syncNow, pendingCount, type SyncResult } from "./sync";
import { conflictCount } from "@/db/queries";
import { onLocalWrite } from "./write-signal";

const INTERVAL_MS = 25_000; // light periodic sync while foregrounded
const WRITE_DEBOUNCE_MS = 1_500; // coalesce bursts of local edits into one sync

export type SyncState = "idle" | "syncing" | "offline";

export interface SyncSnapshot {
  state: SyncState;
  pending: number;
  conflicts: number;
  lastResult: SyncResult | null;
}

type Listener = (snap: SyncSnapshot) => void;
/** Emitted when a sync applied inbound peer changes — screens should reload. */
type DataChangedListener = () => void;

let snapshot: SyncSnapshot = { state: "idle", pending: 0, conflicts: 0, lastResult: null };
const listeners = new Set<Listener>();
const dataListeners = new Set<DataChangedListener>();

let started = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let appStateSub: { remove: () => void } | null = null;
let unsubWrite: (() => void) | null = null;
let inFlight = false;
let pendingRerun = false; // a sync was requested while one was running

function emit(): void {
  for (const l of listeners) l(snapshot);
}

function refreshCounts(): void {
  try {
    snapshot = { ...snapshot, pending: pendingCount(), conflicts: conflictCount() };
  } catch {
    /* db not ready yet */
  }
}

/** Subscribe to sync-state changes. Returns an unsubscribe fn. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  fn(snapshot);
  return () => listeners.delete(fn);
}

/** Subscribe to inbound data changes (peer ops applied). Returns unsubscribe. */
export function onDataChanged(fn: DataChangedListener): () => void {
  dataListeners.add(fn);
  return () => dataListeners.delete(fn);
}

export function getSnapshot(): SyncSnapshot {
  return snapshot;
}

/**
 * Run one sync. Coalesces concurrent requests: if a sync is already running,
 * we flag a re-run so the latest local writes still get flushed afterwards.
 */
export async function requestSync(_reason: string = "manual"): Promise<void> {
  if (inFlight) {
    pendingRerun = true;
    return;
  }
  inFlight = true;
  snapshot = { ...snapshot, state: "syncing" };
  emit();
  try {
    const res = await syncNow();
    snapshot = {
      state: res.connected ? "idle" : "offline",
      pending: pendingCount(),
      conflicts: conflictCount(),
      lastResult: res,
    };
    emit();
    // Inbound changes landed → tell screens to reload their queries.
    if (res.connected && res.peerOpsApplied > 0) {
      for (const l of dataListeners) l();
    }
  } catch {
    snapshot = { ...snapshot, state: "offline" };
    emit();
  } finally {
    inFlight = false;
    if (pendingRerun) {
      pendingRerun = false;
      void requestSync("rerun");
    }
  }
}

/**
 * Signal that a local write just happened. Debounced so a burst of edits (e.g.
 * typing, dragging cards) collapses into a single sync shortly after settling.
 * Also bumps the pending count immediately so the UI reflects the change.
 */
export function noteLocalWrite(): void {
  refreshCounts();
  emit();
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void requestSync("post-write");
  }, WRITE_DEBOUNCE_MS);
}

function handleAppState(next: AppStateStatus): void {
  if (next === "active") void requestSync("foreground");
}

/** Start the auto-sync scheduler. Idempotent — safe to call once at app root. */
export function startAutoSync(): void {
  if (started) return;
  started = true;
  refreshCounts();
  emit();

  appStateSub = AppState.addEventListener("change", handleAppState);
  unsubWrite = onLocalWrite(noteLocalWrite);
  intervalId = setInterval(() => {
    if (AppState.currentState === "active") void requestSync("interval");
  }, INTERVAL_MS);

  // Initial sync shortly after boot (let the DB + screens settle first).
  setTimeout(() => void requestSync("launch"), 1_200);
}

/** Tear down (mainly for tests / hot-reload cleanliness). */
export function stopAutoSync(): void {
  started = false;
  if (intervalId) clearInterval(intervalId);
  if (writeTimer) clearTimeout(writeTimer);
  appStateSub?.remove();
  unsubWrite?.();
  intervalId = null;
  writeTimer = null;
  appStateSub = null;
  unsubWrite = null;
}
