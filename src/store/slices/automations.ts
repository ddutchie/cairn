/**
 * Heartbeat automations slice.
 *
 * Manages scheduled / recurring background agent tasks (`automations` table),
 * loaded via the `automation:*` IPC channels. Mirrors the slash-commands slice:
 * persisted rows loaded on demand, local mutations update the store optimistically
 * from the saved row returned by main.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { ID } from "@/types";
import type {
  Automation, AutomationInput, AutomationRun, AutomationRunWithAutomation,
} from "../../../shared/types/automations";
import { automationsClient } from "@/lib/ipc/automations";
import { hasElectron, reportIpcError } from "@/lib/ipc/client";

export type {
  ScheduleKind, AutomationEnv, AutomationEnvSpec, Automation, AutomationRunStatus, AutomationRun,
  AutomationRunWithAutomation, AutomationInput,
} from "../../../shared/types/automations";

// ── Slice interface ───────────────────────────────────────────────────────────

export interface AutomationsSlice {
  automations: Automation[];
  /** Last run per automation (for "last run" column); refetched on demand. */
  lastRuns: Record<ID, AutomationRun | undefined>;
  /** Full run history per automation (loaded for the detail view). */
  runsById: Record<ID, AutomationRun[]>;
  /**
   * Recent runs across automations scoped to the active project (joined with
   * automation name). Driven by the project Overview's "Recent run results"
   * feed. Empty until `fetchRecentProjectRuns` is called on Overview mount.
   */
  recentProjectRuns: AutomationRunWithAutomation[];
  /** Number of automation runs currently in flight (title-bar running bar). */
  runningAutomationCount: number;
  /**
   * automationId → active Develop session id. Lets "Develop" REOPEN a running
   * dev session for an automation instead of spawning a fresh one (so closing
   * the dev modal never orphans in-flight work).
   */
  automationDevSessions: Record<ID, ID>;

  fetchAutomations: (workspaceId: ID) => Promise<void>;
  createAutomation: (input: AutomationInput) => Promise<Automation | null>;
  updateAutomation: (id: ID, patch: Partial<Omit<AutomationInput, "workspaceId">>) => Promise<void>;
  deleteAutomation: (id: ID) => Promise<void>;
  runNow: (id: ID) => Promise<boolean>;
  fetchRun: (automationId: ID) => Promise<AutomationRun | undefined>;
  fetchRuns: (automationId: ID, limit?: number) => Promise<void>;
  fetchRecentProjectRuns: (workspaceId: ID, projectId: ID, limit?: number) => Promise<void>;
  fetchRunningCount: () => Promise<void>;
  registerAutomationDevSession: (automationId: ID, sessionId: ID) => void;
  clearAutomationDevSession: (automationId: ID) => void;
  /** Poll the live running-automation count for the sidebar badge. */
  startRunCountPolling: () => void;
  stopRunCountPolling: () => void;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

// Module-level poller so only one interval runs regardless of how many times the
// slice is instantiated / mounted.
let approvalPollTimer: ReturnType<typeof setInterval> | null = null;
const APPROVAL_POLL_MS = 15_000;

export const createAutomationsSlice: StateCreator<CairnStore, [], [], AutomationsSlice> = (
  set,
  get
) => ({
  automations: [],
  lastRuns: {},
  runsById: {},
  recentProjectRuns: [],
  runningAutomationCount: 0,
  automationDevSessions: {},

  registerAutomationDevSession(automationId, sessionId) {
    set((s) => ({ automationDevSessions: { ...s.automationDevSessions, [automationId]: sessionId } }));
  },

  clearAutomationDevSession(automationId) {
    set((s) => {
      if (!(automationId in s.automationDevSessions)) return s;
      const next = { ...s.automationDevSessions };
      delete next[automationId];
      return { automationDevSessions: next };
    });
  },

  async fetchAutomations(workspaceId) {
    if (!hasElectron()) return;
    try {
      const rows = await automationsClient.list(workspaceId);
      if (get().activeWorkspaceId && get().activeWorkspaceId !== workspaceId) return;
      set({ automations: rows });
    } catch (err) {
      console.error("[automations] fetchAutomations error", err);
    }
  },

  async createAutomation(input) {
    if (!hasElectron()) return null;
    try {
      const saved = await automationsClient.create(input);
      set((s) => ({ automations: [...s.automations, saved] }));
      return saved;
    } catch (err) {
      reportIpcError(err, "Couldn't create the automation");
      return null;
    }
  },

  async updateAutomation(automationId, patch) {
    if (!hasElectron()) return;
    try {
      const saved = await automationsClient.update(automationId, patch);
      if (!saved) return;
      set((s) => ({
        automations: s.automations.map((a) => (a.id === automationId ? saved : a)),
      }));
    } catch (err) {
      reportIpcError(err, "Couldn't update the automation");
    }
  },

  async deleteAutomation(automationId) {
    if (!hasElectron()) return;
    try {
      await automationsClient.delete(automationId);
      set((s) => ({
        automations: s.automations.filter((a) => a.id !== automationId),
        lastRuns: { ...s.lastRuns, [automationId]: undefined },
      }));
    } catch (err) {
      reportIpcError(err, "Couldn't delete the automation");
    }
  },

  async runNow(automationId) {
    if (!hasElectron()) return false;
    try {
      const res = await automationsClient.runNow(automationId);
      if ("runId" in res) {
        // Refresh runs so the new run row shows immediately.
        const run = await automationsClient.runs(automationId, 1);
        if (run[0]) {
          set((s) => ({ lastRuns: { ...s.lastRuns, [automationId]: run[0] } }));
        }
        return true;
      }
      return false;
    } catch (err) {
      reportIpcError(err, "Couldn't start the automation");
      return false;
    }
  },

  async fetchRun(automationId) {
    if (!hasElectron()) return undefined;
    try {
      const runs = await automationsClient.runs(automationId, 1);
      const run = runs[0];
      set((s) => ({ lastRuns: { ...s.lastRuns, [automationId]: run } }));
      return run;
    } catch (err) {
      console.error("[automations] fetchRun error", err);
      return undefined;
    }
  },

  async fetchRuns(automationId, limit = 20) {
    if (!hasElectron()) return;
    try {
      const runs = await automationsClient.runs(automationId, limit);
      set((s) => ({ runsById: { ...s.runsById, [automationId]: runs } }));
    } catch (err) {
      console.error("[automations] fetchRuns error", err);
    }
  },

  async fetchRecentProjectRuns(workspaceId, projectId, limit = 8) {
    if (!hasElectron()) return;
    // Clear the previous project's rows immediately so the Overview never shows
    // stale runs while the new project's fetch is in flight (or if it fails).
    if (get().activeWorkspaceId === workspaceId && get().activeProjectId === projectId) {
      set({ recentProjectRuns: [] });
    }
    try {
      const rows = await automationsClient.recentRuns(workspaceId, projectId, limit);
      // Guard against a stale fetch landing after the user switched projects
      // (or workspaces).
      if (get().activeWorkspaceId !== workspaceId || get().activeProjectId !== projectId) return;
      set({ recentProjectRuns: rows });
    } catch (err) {
      console.error("[automations] fetchRecentProjectRuns error", err);
    }
  },

  async fetchRunningCount() {
    if (!hasElectron()) return;
    try {
      const n = await automationsClient.runningCount();
      set({ runningAutomationCount: n });
    } catch (err) {
      console.error("[automations] fetchRunningCount error", err);
    }
  },

  startRunCountPolling() {
    if (approvalPollTimer) return;
    void get().fetchRunningCount();
    approvalPollTimer = setInterval(() => {
      void get().fetchRunningCount();
    }, APPROVAL_POLL_MS);
  },

  stopRunCountPolling() {
    if (approvalPollTimer) {
      clearInterval(approvalPollTimer);
      approvalPollTimer = null;
    }
  },

});
