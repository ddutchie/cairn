/** Heartbeat automations. */

import { invokeContract, onIpcEvent } from "./ipc";
import type { AutomationInput, AutomationPatch, AutomationRequirement, AutomationRunEvent } from "../../shared/types/automations";

export const automationsApi = {
  // ── Heartbeat automations ─────────────────────
  automation: {
    list:   (workspaceId: string) => invokeContract("db:automation:list", { workspaceId }),
    get:    (id: string) => invokeContract("db:automation:get", { id }),
    create: (input: AutomationInput) => invokeContract("db:automation:create", input),
    update: (id: string, patch: AutomationPatch) => invokeContract("db:automation:update", { id, patch }),
    delete: (id: string) => invokeContract("db:automation:delete", { id }),
    runs:   (automationId: string, limit?: number) => invokeContract("db:automation:runs", { automationId, limit }),
    recentRuns: (workspaceId: string, projectId?: string | null, limit?: number) =>
      invokeContract("db:automation:recentRuns", { workspaceId, projectId: projectId ?? null, limit }),
    runNow: (id: string) => invokeContract("db:automation:runNow", { id }),
    /** Daily automation budget (USD) + today's recorded automation spend. */
    budget: {
      get: () => invokeContract("db:automation:budget:get"),
      set: (usd: number | null) => invokeContract("db:automation:budget:set", { usd }),
    },
    runningCount: () => invokeContract("db:automation:runningCount"),
    /** Approve/deny a pending tool approval for a running automation (Cordis). */
    approve: (callId: string, approved: boolean, grant?: "session" | "always") =>
      invokeContract("automation:approve", { callId, approved, grant }),
    folder: (id: string) => invokeContract("db:automation:folder", { id }),
    syncFromManifest: (id: string) => invokeContract("db:automation:syncFromManifest", { id }),
    files: (id: string) => invokeContract("db:automation:files", { id }),
    runLog: (runId: string) => invokeContract("db:automation:runLog", { runId }),
    /** Live run activity (tokens/tools/thought) for the "watch this run" view. */
    onRunEvent: (cb: (payload: AutomationRunEvent) => void) => onIpcEvent("automation:run", cb),
    env: {
      get: (automationId: string) => invokeContract("db:automation:env", { automationId }),
      set: (automationId: string, name: string, value: string, secret: boolean) =>
        invokeContract("db:automation:env:set", { automationId, name, value, secret }),
      delete: (automationId: string, name: string) => invokeContract("db:automation:env:delete", { automationId, name }),
    },
    /** Installed/attached status per required connector (New Automation browse guard). */
    checkRequirements: (workspaceId: string, projectId: string, requires: AutomationRequirement[]) =>
      invokeContract("db:automation:checkRequirements", { workspaceId, projectId, requires }),
    preview: (scheduleKind: string, scheduleExpr: string, timezone?: string | null) =>
      invokeContract("db:automation:preview", { scheduleKind, scheduleExpr, timezone }),
  },
} as const;
