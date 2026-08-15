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
import type { ID, RegistryRequirement } from "@/types";
import { id } from "@/lib/utils";

export type ScheduleKind = "cron" | "every" | "once";

/** An automation env var. Non-secret values inline; secrets live in the keychain. */
export interface AutomationEnv {
  name: string;
  value?: string | null;
  secret: boolean;
}

/** Env spec as returned by the env IPC (never reveals secret values). */
export interface AutomationEnvSpec {
  name: string;
  secret: boolean;
  value?: string;
  set?: boolean;
}

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
  approvalMode: "auto" | "ask";
  activeHoursStart: string | null;
  activeHoursEnd: string | null;
  standingRules: Array<{ tool: string; target?: string }>;
  /**
   * External connectors (MCP servers / HTTP services) the automation needs in
   * scope. Empty = data-only automation.
   */
  requires: RegistryRequirement[];
  /** Env vars exposed to scripts; secrets live in the keychain, not here. */
  env: AutomationEnv[];
  source: "custom" | "community";
  communityId: ID | null;
  createdAt: string;
  updatedAt: string;
}

export type AutomationRunStatus = "pending" | "running" | "done" | "exhausted" | "denied" | "error" | "skipped";

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

/**
 * A run joined with its parent automation's name + project (mirrors
 * `AutomationRunWithAutomation` in `electron/db/automation-queries.ts`).
 * Used by the project Overview's "Recent run results" feed so each row can
 * show the automation name without an N+1 lookup.
 */
export interface AutomationRunWithAutomation extends AutomationRun {
  automationName: string;
  automationProjectId: ID | null;
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
  approvalMode?: "auto" | "ask";
  activeHoursStart?: string | null;
  activeHoursEnd?: string | null;
  standingRules?: Array<{ tool: string; target?: string }>;
  requires?: RegistryRequirement[];
  env?: AutomationEnv[];
  /** Provenance when prefilled from the cairn-community catalog. */
  source?: "custom" | "community";
  communityId?: ID | null;
}

// ── Approval inbox (parked from 'ask'-mode automation runs) ──────────────────

export interface ApprovalItem {
  id: ID;
  runId: ID | null;
  sessionId: ID | null;
  tool: string;
  args: Record<string, unknown>;
  kind: "approval" | "question" | "notification" | "plan";
  title: string;
  body: string;
  state: "pending" | "resolved" | "expired";
  resolution: "approved_once" | "approved_session" | "approved_always" | "denied" | null;
  createdAt: string;
  resolvedAt: string | null;
}

export type ApprovalResolution = "approved_once" | "approved_session" | "approved_always" | "denied";

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
  /** Pending approval items (parked by 'ask'-mode runs), newest first. */
  pendingApprovals: ApprovalItem[];
  /** Live pending-approval count for the sidebar badge. */
  pendingApprovalCount: number;
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
  fetchPendingApprovals: () => Promise<void>;
  fetchApprovalCount: () => Promise<void>;
  fetchRunningCount: () => Promise<void>;
  registerAutomationDevSession: (automationId: ID, sessionId: ID) => void;
  clearAutomationDevSession: (automationId: ID) => void;
  resolveApprovalItem: (id: ID, resolution: ApprovalResolution) => Promise<void>;
  startApprovalPolling: () => void;
  stopApprovalPolling: () => void;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

// Module-level poller so only one interval runs regardless of how many times the
// slice is instantiated / mounted.
let approvalPollTimer: ReturnType<typeof setInterval> | null = null;
const APPROVAL_POLL_MS = 3_000;

export const createAutomationsSlice: StateCreator<CairnStore, [], [], AutomationsSlice> = (
  set,
  get
) => ({
  automations: [],
  lastRuns: {},
  runsById: {},
  recentProjectRuns: [],
  pendingApprovals: [],
  pendingApprovalCount: 0,
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

  async fetchRuns(automationId, limit = 20) {
    if (typeof window === "undefined" || !window.electron?.automation) return;
    try {
      const runs = (await window.electron.automation.runs(automationId, limit)) as AutomationRun[];
      set((s) => ({ runsById: { ...s.runsById, [automationId]: runs } }));
    } catch (err) {
      console.error("[automations] fetchRuns error", err);
    }
  },

  async fetchRecentProjectRuns(workspaceId, projectId, limit = 8) {
    if (typeof window === "undefined" || !window.electron?.automation) return;
    // Clear the previous project's rows immediately so the Overview never shows
    // stale runs while the new project's fetch is in flight (or if it fails).
    if (get().activeWorkspaceId === workspaceId && get().activeProjectId === projectId) {
      set({ recentProjectRuns: [] });
    }
    try {
      const rows = (await window.electron.automation.recentRuns(workspaceId, projectId, limit)) as AutomationRunWithAutomation[];
      // Guard against a stale fetch landing after the user switched projects
      // (or workspaces).
      if (get().activeWorkspaceId !== workspaceId || get().activeProjectId !== projectId) return;
      set({ recentProjectRuns: rows });
    } catch (err) {
      console.error("[automations] fetchRecentProjectRuns error", err);
    }
  },

  async fetchPendingApprovals() {
    if (typeof window === "undefined" || !window.electron?.approval) return;
    try {
      const items = (await window.electron.approval.listPending()) as ApprovalItem[];
      set({ pendingApprovals: items, pendingApprovalCount: items.length });
    } catch (err) {
      console.error("[automations] fetchPendingApprovals error", err);
    }
  },

  async fetchApprovalCount() {
    if (typeof window === "undefined" || !window.electron?.approval) return;
    try {
      const n = (await window.electron.approval.count()) as number;
      set({ pendingApprovalCount: n });
    } catch (err) {
      console.error("[automations] fetchApprovalCount error", err);
    }
  },

  async fetchRunningCount() {
    if (typeof window === "undefined" || !window.electron?.automation) return;
    try {
      const n = (await window.electron.automation.runningCount()) as number;
      set({ runningAutomationCount: n });
    } catch (err) {
      console.error("[automations] fetchRunningCount error", err);
    }
  },

  async resolveApprovalItem(approvalId, resolution) {
    if (typeof window === "undefined" || !window.electron?.approval) return;
    try {
      await window.electron.approval.resolve(approvalId, resolution);
      set((s) => ({
        pendingApprovals: s.pendingApprovals.filter((i) => i.id !== approvalId),
        pendingApprovalCount: Math.max(0, s.pendingApprovalCount - 1),
      }));
    } catch (err) {
      console.error("[automations] resolveApprovalItem error", err);
    }
  },

  startApprovalPolling() {
    if (approvalPollTimer) return;
    approvalPollTimer = setInterval(() => {
      void get().fetchApprovalCount();
      void get().fetchRunningCount();
    }, APPROVAL_POLL_MS);
  },

  stopApprovalPolling() {
    if (approvalPollTimer) {
      clearInterval(approvalPollTimer);
      approvalPollTimer = null;
    }
  },
});
