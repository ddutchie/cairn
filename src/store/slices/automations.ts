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
import { id } from "@/lib/utils";

export type ScheduleKind = "cron" | "every" | "once";

export interface Automation {
  id: ID;
  workspaceId: ID;
  projectId: ID | null;
  name: string;
  description: string;
  instructions: string;
  scheduleKind: ScheduleKind;
  scheduleExpr: string;
  timezone: string | null;
  nextRunAt: string;
  enabled: boolean;
  maxRuns: number | null;
  runCount: number;
  standingRules: Array<{ tool: string; target?: string }>;
  source: "custom" | "community";
  communityId: ID | null;
  createdAt: string;
  updatedAt: string;
}

export type AutomationRunStatus = "pending" | "running" | "done" | "denied" | "error" | "skipped";

export interface AutomationRun {
  id: ID;
  automationId: ID;
  status: AutomationRunStatus;
  resultNoteId: ID | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  scratch: string | null;
  createdAt: string;
}

export interface AutomationInput {
  workspaceId: ID;
  projectId?: ID | null;
  name: string;
  description?: string;
  instructions: string;
  scheduleKind: ScheduleKind;
  scheduleExpr: string;
  /** Computed main-side from scheduleExpr when omitted. */
  nextRunAt?: string;
  timezone?: string | null;
  enabled?: boolean;
  maxRuns?: number | null;
  standingRules?: Array<{ tool: string; target?: string }>;
}

// ── Slice interface ───────────────────────────────────────────────────────────

export interface AutomationsSlice {
  automations: Automation[];
  /** Last run per automation (for "last run" column); refetched on demand. */
  lastRuns: Record<ID, AutomationRun | undefined>;

  fetchAutomations: (workspaceId: ID) => Promise<void>;
  createAutomation: (input: AutomationInput) => Promise<Automation | null>;
  updateAutomation: (id: ID, patch: Partial<Omit<AutomationInput, "workspaceId">>) => Promise<void>;
  deleteAutomation: (id: ID) => Promise<void>;
  runNow: (id: ID) => Promise<boolean>;
  fetchRun: (automationId: ID) => Promise<AutomationRun | undefined>;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createAutomationsSlice: StateCreator<CairnStore, [], [], AutomationsSlice> = (
  set,
  get
) => ({
  automations: [],
  lastRuns: {},

  async fetchAutomations(workspaceId) {
    if (typeof window === "undefined" || !window.electron?.automation) return;
    try {
      const rows = (await window.electron.automation.list(workspaceId)) as Automation[];
      if (get().activeWorkspaceId && get().activeWorkspaceId !== workspaceId) return;
      set({ automations: rows });
    } catch (err) {
      console.error("[automations] fetchAutomations error", err);
    }
  },

  async createAutomation(input) {
    if (typeof window === "undefined" || !window.electron?.automation) return null;
    try {
      const saved = (await window.electron.automation.create({
        ...input,
        id: id(),
      })) as Automation;
      set((s) => ({ automations: [...s.automations, saved] }));
      return saved;
    } catch (err) {
      console.error("[automations] createAutomation error", err);
      return null;
    }
  },

  async updateAutomation(automationId, patch) {
    if (typeof window === "undefined" || !window.electron?.automation) return;
    try {
      const saved = (await window.electron.automation.update(automationId, patch)) as Automation;
      set((s) => ({
        automations: s.automations.map((a) => (a.id === automationId ? saved : a)),
      }));
    } catch (err) {
      console.error("[automations] updateAutomation error", err);
    }
  },

  async deleteAutomation(automationId) {
    if (typeof window === "undefined" || !window.electron?.automation) return;
    try {
      await window.electron.automation.delete(automationId);
      set((s) => ({
        automations: s.automations.filter((a) => a.id !== automationId),
        lastRuns: { ...s.lastRuns, [automationId]: undefined },
      }));
    } catch (err) {
      console.error("[automations] deleteAutomation error", err);
    }
  },

  async runNow(automationId) {
    if (typeof window === "undefined" || !window.electron?.automation) return false;
    try {
      const res = (await window.electron.automation.runNow(automationId)) as
        | { runId: string }
        | { skipped: boolean };
      if ("runId" in res) {
        // Refresh runs so the new run row shows immediately.
        const run = (await window.electron.automation.runs(automationId, 1)) as AutomationRun[];
        if (run[0]) {
          set((s) => ({ lastRuns: { ...s.lastRuns, [automationId]: run[0] } }));
        }
        return true;
      }
      return false;
    } catch (err) {
      console.error("[automations] runNow error", err);
      return false;
    }
  },

  async fetchRun(automationId) {
    if (typeof window === "undefined" || !window.electron?.automation) return undefined;
    try {
      const runs = (await window.electron.automation.runs(automationId, 1)) as AutomationRun[];
      const run = runs[0];
      set((s) => ({ lastRuns: { ...s.lastRuns, [automationId]: run } }));
      return run;
    } catch (err) {
      console.error("[automations] fetchRun error", err);
      return undefined;
    }
  },
});
