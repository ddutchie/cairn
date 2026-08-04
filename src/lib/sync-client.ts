"use client";

/**
 * Desktop sync status + conflict-resolution client.
 *
 * A tiny standalone store (not part of the big Zustand domain store) because
 * sync status is window-chrome state, decoupled from the persisted workspace
 * data. Subscribes to pushed `sync:status` events from the main process (see
 * electron/main.ts setSyncStatusListener) and exposes the current snapshot plus
 * the conflict list/resolve actions.
 *
 * window.electron.sync is declared in electron/preload.ts; we type it locally
 * (matching SyncSettings.tsx) to avoid editing the global electron.d.ts.
 */

import { useEffect, useSyncExternalStore } from "react";

export type SyncState = "disabled" | "idle" | "syncing" | "offline";

export interface SyncStatus {
  state: SyncState;
  pending: number;
  conflicts: number;
  lastSyncAt: string | null;
  connected: boolean;
}

export interface ConflictCopy {
  id: string;
  title: string;
  content: string | null;
  projectId: string;
  folder: string;
  updatedAt: string;
  deviceId: string | null;
  originalId: string | null;
  original: { id: string; title: string; content: string | null; updatedAt: string } | null;
  /** Common-ancestor body for a 3-way merge, if the engine recorded one. */
  baseBody: string | null;
}

export type SyncOutcome = "applied" | "conflict-copy" | "delete-won" | "skipped-stale";

/** One reconcile decision, as recorded by the engine's activity log. */
export interface SyncActivityEntry {
  seq: number;
  at: string;
  entity: string;
  entity_id: string;
  op: "put" | "delete";
  hlc: string;
  origin: string;
  outcome: SyncOutcome;
  conflict_copy_id: string | null;
  /** Current title of the affected row, or null if it no longer exists. */
  title: string | null;
  /** True when this device authored the change. */
  isSelf: boolean;
  /** Whose version the conflict copy holds. */
  conflict_side: "local" | "remote" | null;
}

/** A note another device deleted that can still be brought back. */
export interface RestorableNote {
  entity: string;
  entity_id: string;
  title: string | null;
  /** When the delete was authored on the originating device. */
  deleted_at: string | null;
  delete_origin: string | null;
}

/** Why a restore was refused, straight from the engine. */
export type RestoreRefusal =
  | "missing"
  | "live"
  | "shell"
  | "conflict-copy"
  | "orphaned"
  | "self-deleted";

export interface RestoreOutcome {
  restored: boolean;
  reason?: RestoreRefusal | string;
  fileError?: string;
}

type SyncApi = {
  status: () => Promise<SyncStatus>;
  onStatus: (cb: (s: SyncStatus) => void) => () => void;
  listConflicts: () => Promise<ConflictCopy[]>;
  resolveConflict: (
    copyId: string,
    action: "keepCopy" | "keepOriginal" | "keepMerged",
    mergedContent?: string,
  ) => Promise<{ resolvedOriginalId: string | null }>;
  now: () => Promise<{ connected: boolean }>;
  activity: (limit?: number) => Promise<SyncActivityEntry[]>;
  listRestorable: (limit?: number) => Promise<{ rows: RestorableNote[]; total: number }>;
  restoreNote: (id: string) => Promise<RestoreOutcome>;
};

export function syncApi(): SyncApi | null {
  if (typeof window === "undefined" || !window.electron) return null;
  return (window.electron as unknown as { sync?: SyncApi }).sync ?? null;
}

const DEFAULT_STATUS: SyncStatus = {
  state: "disabled",
  pending: 0,
  conflicts: 0,
  lastSyncAt: null,
  connected: false,
};

// ── Minimal external store so many components share one live snapshot ────────

let current: SyncStatus = DEFAULT_STATUS;
const listeners = new Set<() => void>();
let started = false;
let unsub: (() => void) | null = null;

function emit(): void {
  for (const l of listeners) l();
}

function setStatus(next: SyncStatus): void {
  current = next;
  emit();
}

/** Begin subscribing to pushed status events + prime the initial snapshot. */
function ensureStarted(): void {
  if (started) return;
  const api = syncApi();
  if (!api) return; // browser / non-Electron — stays "disabled"
  started = true;
  api.status().then(setStatus).catch(() => {});
  unsub = api.onStatus(setStatus);
}

function subscribe(cb: () => void): () => void {
  ensureStarted();
  listeners.add(cb);
  return () => removeListener(cb);
}

/** Remove a listener and tear down the IPC subscription when the last one goes. */
function removeListener(cb: () => void): void {
  listeners.delete(cb);
  if (listeners.size === 0 && unsub) {
    unsub();
    unsub = null;
    started = false;
    // Reset so a later remount doesn't briefly render a stale snapshot (e.g.
    // "connected" after sync was disconnected while nothing was subscribed).
    current = DEFAULT_STATUS;
  }
}

/** Live sync status snapshot. Returns "disabled" outside Electron. */
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribe, () => current, () => DEFAULT_STATUS);
}

/** Imperatively refetch conflicts (used by the resolution modal). */
export async function fetchConflicts(): Promise<ConflictCopy[]> {
  const api = syncApi();
  if (!api) return [];
  try {
    return await api.listConflicts();
  } catch {
    return [];
  }
}

export async function resolveConflict(
  copyId: string,
  action: "keepCopy" | "keepOriginal" | "keepMerged",
  mergedContent?: string,
): Promise<void> {
  const api = syncApi();
  if (!api) return;
  await api.resolveConflict(copyId, action, mergedContent);
}

/** Recent reconcile decisions, newest first. Empty outside Electron. */
export async function fetchSyncActivity(limit = 100): Promise<SyncActivityEntry[]> {
  const api = syncApi();
  if (!api?.activity) return [];
  try {
    return await api.activity(limit);
  } catch {
    return [];
  }
}

/** Notes a peer deleted that can still be restored. Empty outside Electron. */
export async function fetchRestorableNotes(limit = 50): Promise<{ rows: RestorableNote[]; total: number }> {
  const api = syncApi();
  if (!api?.listRestorable) return { rows: [], total: 0 };
  try {
    const res = await api.listRestorable(limit);
    return { rows: res?.rows ?? [], total: res?.total ?? 0 };
  } catch {
    return { rows: [], total: 0 };
  }
}

/**
 * Bring back a note a peer deleted.
 *
 * Errors are returned rather than swallowed: a recovery action that silently
 * does nothing is indistinguishable from a bug, so the caller must be able to
 * tell the user why it didn't work.
 */
export async function restoreDeletedNote(id: string): Promise<RestoreOutcome> {
  const api = syncApi();
  if (!api?.restoreNote) return { restored: false, reason: "missing" };
  try {
    return await api.restoreNote(id);
  } catch (err) {
    return { restored: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Trigger a manual sync now (from the popover). */
export async function triggerSyncNow(): Promise<void> {
  const api = syncApi();
  if (!api) return;
  try {
    await api.now();
  } catch {
    /* status event will surface the offline state */
  }
}

/** Subscribe a callback to status changes outside React (rarely needed). */
export function onSyncStatus(cb: (s: SyncStatus) => void): () => void {
  ensureStarted();
  const wrapped = () => cb(current);
  listeners.add(wrapped);
  // Use the shared teardown so unsubscribing the last listener still releases
  // the IPC subscription (otherwise it would leak).
  return () => removeListener(wrapped);
}

/** No-op export kept for symmetry; the hook auto-starts on first mount. */
export function useEnsureSyncStarted(): void {
  useEffect(() => {
    ensureStarted();
  }, []);
}

// ── Conflict-modal open state (shared so the title-bar indicator, the banner,
//    and the modal itself all reference one source of truth) ─────────────────

let conflictModalOpen = false;
const modalListeners = new Set<() => void>();

function emitModal(): void {
  for (const l of modalListeners) l();
}

export function openConflictModal(): void {
  conflictModalOpen = true;
  emitModal();
}

export function closeConflictModal(): void {
  conflictModalOpen = false;
  emitModal();
}

function subscribeModal(cb: () => void): () => void {
  modalListeners.add(cb);
  return () => modalListeners.delete(cb);
}

export function useConflictModalOpen(): boolean {
  return useSyncExternalStore(subscribeModal, () => conflictModalOpen, () => false);
}
