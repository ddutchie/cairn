/**
 * Cairn — Undo / Redo history manager
 *
 * Architecture:
 *  - `historyManager` is a module-level singleton so Zustand slices can
 *    import and call it without React hooks.
 *  - `flowHandlers` is a registry that the Idea Flow canvas populates on
 *    mount, giving flow commands a way to patch local React Flow state
 *    during undo/redo without a full DB re-fetch (no flicker).
 *  - `useHistory()` is a React hook that re-renders the caller whenever
 *    the history stack changes (used for canUndo / canRedo reactivity).
 *
 * Rules:
 *  - Commands are pushed AFTER the mutation has already been applied.
 *  - MCP / AI writes call `historyManager.clear()` to invalidate the stack.
 *  - Max 50 steps; oldest dropped when exceeded.
 *  - Session-only: history is not persisted across restarts.
 */

import { useEffect, useState } from "react";
import type { Edge, Node } from "@xyflow/react";

// ── Command interface ──────────────────────────────────────────────────────────

export interface Command {
  /** Short human-readable label shown in undo/redo toasts, e.g. "Move task to Done" */
  label: string;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

// ── Flow canvas handler registry ──────────────────────────────────────────────
// Populated by IdeaFlowCanvas on mount; cleared on unmount.
// Flow commands call these to patch local React Flow state without a full reload.

// Touched by ipc() and flow-view on every own DB write so that page.tsx's
// db:changed listener knows not to clear history for those events.
export const ownWriteGuard = {
  /** Millisecond timestamp of the last own write. */
  lastWriteAt: 0,
  /** Returns true if a db:changed event is likely from our own write. */
  isOwnWrite(): boolean {
    return Date.now() - this.lastWriteAt < 3000;
  },
  touch() {
    this.lastWriteAt = Date.now();
  },
};

/** @deprecated use ownWriteGuard */
export const flowWriteGuard = ownWriteGuard;

export const flowHandlers: {
  addNode:    ((node: Node) => void) | null;
  removeNode: ((id: string) => void) | null;
  updateNode: ((id: string, data: Record<string, unknown>) => void) | null;
  moveNode:   ((id: string, position: { x: number; y: number }, parentId?: string) => void) | null;
  resizeNode: ((id: string, width: number, height: number) => void) | null;
  addEdge:    ((edge: Edge) => void) | null;
  removeEdge: ((id: string) => void) | null;
} = {
  addNode:    null,
  removeNode: null,
  updateNode: null,
  moveNode:   null,
  resizeNode: null,
  addEdge:    null,
  removeEdge: null,
};

// ── HistoryManager ─────────────────────────────────────────────────────────────

const MAX_HISTORY = 50;

class HistoryManager {
  private past: Command[] = [];
  private future: Command[] = [];
  private listeners = new Set<() => void>();

  /**
   * Record a command that has already been executed.
   * Clears the redo stack (branching invalidates future).
   */
  push(cmd: Command): void {
    this.past.push(cmd);
    if (this.past.length > MAX_HISTORY) this.past.shift();
    this.future = [];
    this.notify();
  }

  async undo(): Promise<void> {
    const cmd = this.past.pop();
    if (!cmd) return;
    await cmd.undo();
    this.future.unshift(cmd);
    this.notify();
  }

  async redo(): Promise<void> {
    const cmd = this.future.shift();
    if (!cmd) return;
    await cmd.redo();
    this.past.push(cmd);
    this.notify();
  }

  /** Clear both stacks — called when an external (MCP/AI) write is detected. */
  clear(): void {
    if (this.past.length === 0 && this.future.length === 0) return;

    this.past = [];
    this.future = [];
    this.notify();
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  /** Label of the command that would be undone next, or null. */
  get undoLabel(): string | null { return this.past.at(-1)?.label ?? null; }
  /** Label of the command that would be redone next, or null. */
  get redoLabel(): string | null { return this.future[0]?.label ?? null; }

  /**
   * Coalesce: if the top of the past stack is an UpdateNote or UpdateCard
   * command for the same id pushed within `windowMs`, replace its newPatch
   * instead of pushing a new command. Returns true if coalesced.
   */
  coalesceUpdate(
    tag: string,
    id: string,
    windowMs: number,
    updater: (existing: Command) => void,
  ): boolean {
    const top = this.past.at(-1) as (Command & { _tag?: string; _id?: string; _pushedAt?: number }) | undefined;
    if (
      top &&
      top._tag === tag &&
      top._id === id &&
      typeof top._pushedAt === "number" &&
      Date.now() - top._pushedAt < windowMs
    ) {
      updater(top);
      top._pushedAt = Date.now();
      return true;
    }
    return false;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }
}

// ── Module-level singleton ─────────────────────────────────────────────────────

export const historyManager = new HistoryManager();

// ── React hook ────────────────────────────────────────────────────────────────

export function useHistory() {
  const [, rerender] = useState(0);
  useEffect(
    () => historyManager.subscribe(() => rerender((n) => n + 1)),
    [],
  );
  return historyManager;
}
