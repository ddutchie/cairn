/**
 * Typed client for the heartbeat automation IPC channels (`db:automation:*`,
 * `automation:approve`). Every failure — including "not found" / invalid
 * schedule — rejects with the main-process message.
 */

import type {
  Automation, AutomationEnvSpec, AutomationInput, AutomationPatch, AutomationRequirement, AutomationRun, AutomationRunEvent,
  AutomationRunWithAutomation, RunLog,
} from "../../../shared/types/automations";
import type { TodayState } from "../../../shared/today/brief";
import { domainCall, type ElectronApi } from "./client";

const automation = <T>(fn: (api: ElectronApi["automation"]) => Promise<T>) => domainCall("automation", fn);

export const automationsClient = {
  list: (workspaceId: string): Promise<Automation[]> => automation((a) => a.list(workspaceId)),
  create: (input: AutomationInput): Promise<Automation> => automation((a) => a.create(input)),
  update: (id: string, patch: AutomationPatch): Promise<Automation | null> => automation((a) => a.update(id, patch)),
  delete: (id: string) => automation((a) => a.delete(id)),
  runs: (automationId: string, limit?: number): Promise<AutomationRun[]> => automation((a) => a.runs(automationId, limit)),
  recentRuns: (workspaceId: string, projectId: string | null, limit?: number): Promise<AutomationRunWithAutomation[]> =>
    automation((a) => a.recentRuns(workspaceId, projectId, limit)),
  runningCount: (): Promise<number> => automation((a) => a.runningCount()),
  /** Starts a run now; `skipped` when one is already running. */
  runNow: (id: string) => automation((a) => a.runNow(id)),
  /** Live "next run" preview via the main-process schedule parser. */
  preview: (scheduleKind: string, scheduleExpr: string, timezone?: string | null) =>
    automation((a) => a.preview(scheduleKind, scheduleExpr, timezone)),
  approve: (callId: string, approved: boolean, grant?: "session" | "always") =>
    automation((a) => a.approve(callId, approved, grant)),
  /** Tool calls the run is waiting on right now, oldest first. */
  pendingApprovals: async (runId: string): Promise<Array<{ callId: string; tool: string; label: string }>> =>
    (await automation((a) => a.pendingApprovals(runId))).approvals,
  budget: () => automation((a) => a.budget.get()),
  setBudget: (usd: number | null) => automation((a) => a.budget.set(usd)),
  /** The automation's folder (created on first use) — the Develop session's cwd. */
  folder: async (id: string): Promise<string> => (await automation((a) => a.folder(id))).folder,
  syncFromManifest: (id: string) => automation((a) => a.syncFromManifest(id)),
  runLog: async (runId: string): Promise<RunLog> => (await automation((a) => a.runLog(runId))).log,
  env: (automationId: string): Promise<AutomationEnvSpec[]> => automation((a) => a.env.get(automationId)),
  setEnv: (automationId: string, name: string, value: string, secret: boolean): Promise<AutomationEnvSpec[]> =>
    automation((a) => a.env.set(automationId, name, value, secret)),
  deleteEnv: (automationId: string, name: string): Promise<AutomationEnvSpec[]> =>
    automation((a) => a.env.delete(automationId, name)),
  /** Subscribe to live run activity; returns the unsubscribe function (a no-op off-Electron). */
  onRunEvent: (cb: (event: AutomationRunEvent) => void): (() => void) =>
    window.electron?.automation.onRunEvent(cb) ?? (() => {}),
  files: (id: string) => automation((a) => a.files(id)),
  checkRequirements: (workspaceId: string, projectId: string, requires: AutomationRequirement[]) =>
    automation((a) => a.checkRequirements(workspaceId, projectId, requires)),
};

/** The built-in Today automation behind Overview → Today. */
export const todayClient = {
  get: (workspaceId: string, projectId: string): Promise<TodayState> => automation((a) => a.today.get(workspaceId, projectId)),
  enable: (req: { workspaceId: string; projectId: string; time: string; weekdaysOnly: boolean; timezone?: string | null }): Promise<TodayState> =>
    automation((a) => a.today.enable(req)),
  disable: (workspaceId: string, projectId: string): Promise<TodayState> => automation((a) => a.today.disable(workspaceId, projectId)),
  /** Starts a run now; `skipped` when one is already running. */
  run: (workspaceId: string, projectId: string) => automation((a) => a.today.run(workspaceId, projectId)),
  /** Where an item goes and which connector tools could send it. Connects to the in-scope servers, so it can take a moment. */
  route: (req: { workspaceId: string; projectId: string; source: string; target?: string; kind?: string }) =>
    automation((a) => a.today.route(req)),
  /** Saves a debug bundle through a save dialog; null when cancelled. */
  export: (req: { workspaceId: string; projectId: string; local?: { dismissed?: string[]; edits?: Record<string, string> } }) =>
    automation((a) => a.today.export(req)),
};
