/**
 * Cairn plugin-UI slot registry — the runtime store of "who renders where".
 *
 * A UI plugin registers a React component into a declared slot (see slot-matrix).
 * Cairn's slot HOSTS (<SlotOutlet>) look up their entries and render them. List
 * slots render all entries (sorted by order); keyed slots render the one match.
 *
 * Framework-agnostic store + a useSyncExternalStore subscription so hosts
 * re-render when plugins register/unregister live (matching the runtime plugin
 * loader's hot-reload).
 */
import { useSyncExternalStore } from "react";
import type { SlotName, SlotComponent } from "./slot-matrix";
import { SLOT_MATRIX } from "./slot-matrix";

interface Entry {
  id: string;
  key?: string; // keyed slots
  order: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: SlotComponent<any>;
}

const slots = new Map<SlotName, Entry[]>();
const listeners = new Set<() => void>();
// Per-slot snapshot cache so useSyncExternalStore's getSnapshot is referentially
// stable between changes (React requires a stable snapshot or it loops).
const snapshotCache = new Map<SlotName, Entry[]>();

function emit(name: SlotName) {
  snapshotCache.delete(name);
  for (const l of listeners) l();
}

export interface RegisterOptions {
  id: string;
  /** For keyed slots (e.g. tool.call.toolview keyed by tool name). */
  key?: string;
  order?: number;
}

/** Register a component into a slot. Returns a disposer. */
export function registerSlot<K extends SlotName>(
  name: K,
  opts: RegisterOptions,
  component: SlotComponent<K>,
): () => void {
  const list = slots.get(name) ?? [];
  const entry: Entry = { id: opts.id, key: opts.key, order: opts.order ?? 0, component };
  // Replace an existing entry with the same id (live edit = re-register).
  const next = list.filter((e) => e.id !== opts.id).concat(entry).sort((a, b) => a.order - b.order);
  slots.set(name, next);
  emit(name);
  return () => {
    const cur = slots.get(name);
    if (!cur) return;
    slots.set(name, cur.filter((e) => e !== entry));
    emit(name);
  };
}

function getEntries(name: SlotName): Entry[] {
  const cached = snapshotCache.get(name);
  if (cached) return cached;
  const v = slots.get(name) ?? EMPTY;
  snapshotCache.set(name, v);
  return v;
}
const EMPTY: Entry[] = [];

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React hook: the live entries for a slot (re-renders on register/unregister). */
export function useSlotEntries(name: SlotName): Entry[] {
  return useSyncExternalStore(subscribe, () => getEntries(name), () => getEntries(name));
}

/** Non-hook read: does a keyed slot have an entry for this key? Safe outside
 *  render (does not subscribe) — for callers that only need to branch. */
export function slotHasKey(name: SlotName, matchKey: string): boolean {
  return (slots.get(name) ?? []).some((e) => e.key === matchKey);
}

/** Inspection (a future Plugins settings tab). */
export function slotInventory(): Array<{ slot: SlotName; kind: string; scope: string; entries: string[] }> {
  return (Object.keys(SLOT_MATRIX) as SlotName[]).map((slot) => ({
    slot,
    kind: SLOT_MATRIX[slot].kind,
    scope: SLOT_MATRIX[slot].scope,
    entries: (slots.get(slot) ?? []).map((e) => e.id),
  }));
}
