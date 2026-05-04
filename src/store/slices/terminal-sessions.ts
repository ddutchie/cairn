/**
 * Terminal Sessions slice.
 *
 * Tracks ephemeral agent terminal sessions within the Agent view.
 * Sessions are never persisted to SQLite — they live for the app lifetime.
 * TerminalManager (renderer singleton) holds the actual xterm.js instances,
 * keyed by sessionId.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TerminalSession {
  sessionId: string;
  taskId: string;
  taskTitle: string;
  agentId: string;
  agentName: string;
  projectId: string;
  status: "running" | "exited";
  exitCode: number | null;
  spawnedAt: string; // ISO string (JSON-safe)
}

export interface TerminalSessionsSlice {
  terminalSessions: TerminalSession[];
  activeSessionId: string | null;
  /** Ordered list of open file paths in the editor tab strip. */
  openEditorFiles: string[];
  /** Currently active tab — always an element of openEditorFiles, or null. */
  activeEditorFile: string | null;

  addTerminalSession: (session: TerminalSession) => void;
  removeTerminalSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  markSessionExited: (sessionId: string, exitCode: number) => void;
  /** Open a file tab (no-op if already open) and make it active. */
  openEditorFile: (path: string) => void;
  /** Close a file tab; activates the nearest remaining tab. */
  closeEditorFile: (path: string) => void;
  /** @deprecated use openEditorFile */
  setActiveEditorFile: (path: string | null) => void;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createTerminalSessionsSlice: StateCreator<CairnStore, [], [], TerminalSessionsSlice> = (
  set,
  _get
) => ({
  terminalSessions: [],
  activeSessionId: null,
  openEditorFiles: [],
  activeEditorFile: null,

  addTerminalSession(session) {
    set((s) => ({
      terminalSessions: [...s.terminalSessions, session],
      activeSessionId: session.sessionId,
    }));
  },

  removeTerminalSession(sessionId) {
    set((s) => {
      const remaining = s.terminalSessions.filter((t) => t.sessionId !== sessionId);
      const nextActive =
        s.activeSessionId === sessionId
          ? (remaining[remaining.length - 1]?.sessionId ?? null)
          : s.activeSessionId;
      return { terminalSessions: remaining, activeSessionId: nextActive };
    });
  },

  setActiveSession(sessionId) {
    set({ activeSessionId: sessionId });
  },

  markSessionExited(sessionId, exitCode) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) =>
        t.sessionId === sessionId ? { ...t, status: "exited", exitCode } : t
      ),
    }));
  },

  openEditorFile(path) {
    set((s) => ({
      openEditorFiles: s.openEditorFiles.includes(path)
        ? s.openEditorFiles
        : [...s.openEditorFiles, path],
      activeEditorFile: path,
    }));
  },

  closeEditorFile(path) {
    set((s) => {
      const idx = s.openEditorFiles.indexOf(path);
      if (idx === -1) return {};
      const next = s.openEditorFiles.filter((f) => f !== path);
      const nextActive =
        s.activeEditorFile !== path
          ? s.activeEditorFile
          : (next[Math.min(idx, next.length - 1)] ?? null);
      return { openEditorFiles: next, activeEditorFile: nextActive };
    });
  },

  setActiveEditorFile(path) {
    // Legacy: treat as openEditorFile when path given, no-op on null
    if (path) {
      set((s) => ({
        openEditorFiles: s.openEditorFiles.includes(path)
          ? s.openEditorFiles
          : [...s.openEditorFiles, path],
        activeEditorFile: path,
      }));
    }
  },
});
