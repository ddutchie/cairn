/**
 * Typed client for the heartbeat automation IPC channels (`db:automation:*`,
 * `automation:approve`). Every failure — including "not found" / invalid
 * schedule — rejects with the main-process message.
 */

import type {
  Automation, AutomationEnvSpec, AutomationInput, AutomationPatch, AutomationRequirement, AutomationRun, AutomationRunEvent,
  AutomationRunWithAutomation, RunLog,
} from "../../../shared/types/automations";
import type { TodayBrief, TodayHistoryEntry, TodayMarks, TodaySettings, TodayState } from "../../../shared/today/brief";
import { domainCall, type ElectronApi } from "./client";
import type { IpcArgs, IpcEvents } from "../../../shared/ipc/contract";

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
    window.electron?.automation?.onRunEvent(cb) ?? (() => {}),
  files: (id: string) => automation((a) => a.files(id)),
  checkRequirements: (workspaceId: string, projectId: string, requires: AutomationRequirement[]) =>
    automation((a) => a.checkRequirements(workspaceId, projectId, requires)),
};

/** The built-in Today automation behind the Today view (one per workspace). */
export const todayClient = {
  get: (workspaceId: string): Promise<TodayState> => automation((a) => a.today.get(workspaceId)),
  enable: (req: IpcArgs<"today:enable">[0]): Promise<TodayState> =>
    automation((a) => a.today.enable(req)),
  disable: (workspaceId: string): Promise<TodayState> => automation((a) => a.today.disable(workspaceId)),
  /** Which projects and apps Today reads. */
  settings: (workspaceId: string, settings: TodaySettings): Promise<TodayState> => automation((a) => a.today.settings(workspaceId, settings)),
  /** Mark items done or not, and set or drop (null) draft edits, for one day. */
  mark: (workspaceId: string, date: string, patch: Omit<IpcArgs<"today:mark">[0], "workspaceId" | "date">): Promise<TodayMarks> =>
    automation((a) => a.today.mark(workspaceId, date, patch)),
  /** Saved versions, newest first. */
  history: (workspaceId: string): Promise<TodayHistoryEntry[]> => automation((a) => a.today.history(workspaceId)),
  snapshot: (workspaceId: string, key: string): Promise<{ brief: TodayBrief; marks: TodayMarks } | null> =>
    automation((a) => a.today.snapshot(workspaceId, key)),
  /** Starts a run now; `skipped` when one is already running. */
  run: (workspaceId: string, rebuild?: boolean) => automation((a) => a.today.run(workspaceId, rebuild)),
  /** Where an item goes and which connector tools could send it. Connects to the in-scope servers, so it can take a moment. */
  route: (req: IpcArgs<"today:route">[0]) =>
    automation((a) => a.today.route(req)),
  /** Saves a debug bundle through a save dialog; null when cancelled. */
  export: (workspaceId: string) => automation((a) => a.today.export(workspaceId)),
  /** A Today run changed the brief; returns the unsubscribe function (a no-op off-Electron). */
  onUpdated: (cb: (event: IpcEvents["today:updated"]) => void): (() => void) =>
    window.electron?.automation?.today?.onUpdated(cb) ?? (() => {}),
};
