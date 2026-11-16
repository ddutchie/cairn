"use client";

/**
 * Desktop sync status + conflict-resolution client.
 *
 * A tiny standalone store (not part of the big Zustand domain store) because
 * sync status is window-chrome state, decoupled from the persisted workspace
 * data. Subscribes to pushed `sync:status` events from the main process (see
 * electron/main.ts setSyncStatusListener) and exposes the current snapshot plus
 * the conflict list/resolve actions. Transport goes through
 * `src/lib/ipc/sync.ts` (syncClient).
 */

import { useSyncExternalStore } from "react";
import { syncClient } from "./ipc/sync";
import { hasElectron } from "./ipc/client";

import type { ConflictCopy, SyncStatus } from "../../shared/types/sync";
import type {
  PeerProtocol,
  RestorableRow,
  RestoreRefusal,
  SyncActivityRow,
} from "../../shared/sync/engine";

// Wire shapes live in shared/ (single source). Re-exported so existing
// @/lib/sync-client type imports keep working; do not re-declare (F10).
export type { ConflictCopy, SyncState, SyncStatus } from "../../shared/types/sync";
export type { PeerProtocol, RestoreRefusal, SyncOutcome } from "../../shared/sync/engine";
/** Engine SyncActivityRow under its historic client name. */
export type SyncActivityEntry = SyncActivityRow;
/** Engine RestorableRow under its historic client name. */
export type RestorableNote = RestorableRow;

/** Why a restore was refused — desktop file-write wrapper (no engine counterpart). */
export interface RestoreOutcome {
  restored: boolean;
  reason?: RestoreRefusal | string;
  fileError?: string;
}

/** Result of retrying the `.md` write for an already-restored note. */
export interface RepairOutcome {
  repaired: boolean;
  reason?: string;
  fileError?: string;
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

function areSyncStatusesEqual(a: SyncStatus, b: SyncStatus): boolean {
  if (a === b) return true;
  return (
    a.state === b.state &&
    a.pending === b.pending &&
    a.conflicts === b.conflicts &&
    a.lastSyncAt === b.lastSyncAt &&
    a.connected === b.connected
  );
}

function setStatus(next: SyncStatus): void {
  if (areSyncStatusesEqual(current, next)) return;
  current = next;
  emit();
}

/** Begin subscribing to pushed status events + prime the initial snapshot. */
function ensureStarted(): void {
  if (started) return;
  if (!hasElectron("sync")) return; // browser / non-Electron — stays "disabled"
  started = true;
  syncClient.status().then(setStatus).catch(() => {});
  unsub = syncClient.onStatus(setStatus);
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
  if (!hasElectron("sync")) return [];
  try {
    return await syncClient.listConflicts();
  } catch {
    return [];
  }
}

export async function resolveConflict(
  copyId: string,
  action: "keepCopy" | "keepOriginal" | "keepMerged",
  mergedContent?: string,
): Promise<void> {
  if (!hasElectron("sync")) return;
  await syncClient.resolveConflict(copyId, action, mergedContent);
}

/** Recent reconcile decisions, newest first. Empty outside Electron. */
export async function fetchSyncActivity(limit = 100): Promise<SyncActivityEntry[]> {
  if (!hasElectron("sync")) return [];
  try {
    return await syncClient.activity(limit);
  } catch {
    return [];
  }
}

/** Notes a peer deleted that can still be restored. Empty outside Electron. */
export async function fetchRestorableNotes(limit = 50): Promise<{ rows: RestorableNote[]; total: number }> {
  if (!hasElectron("sync")) return { rows: [], total: 0 };
  try {
    const res = await syncClient.listRestorable(limit);
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
  if (!hasElectron("sync")) return { restored: false, reason: "missing" };
  try {
    return await syncClient.restoreNote(id);
  } catch (err) {
    return { restored: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Retry writing a restored note's `.md` file.
 *
 * Needed because the DB half of a restore can succeed while the file write
 * fails; the row is live by then, so a plain retry of the restore would be
 * refused as `live` and the user could never repair it.
 */
export async function repairNoteFile(id: string): Promise<RepairOutcome> {
  if (!hasElectron("sync")) return { repaired: false, reason: "missing" };
  try {
    return await syncClient.repairNoteFile(id);
  } catch (err) {
    return { repaired: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Peers on an older/newer sync protocol than this build. Empty outside Electron. */
export async function fetchPeerProtocols(): Promise<PeerProtocol[]> {
  if (!hasElectron("sync")) return [];
  try {
    return (await syncClient.peerProtocols()) ?? [];
  } catch {
    return [];
  }
}

/** Trigger a manual sync now (from the popover). */
export async function triggerSyncNow(): Promise<void> {
  if (!hasElectron("sync")) return;
  try {
    await syncClient.now();
  } catch {
    /* status event will surface the offline state */
  }
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
