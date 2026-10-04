/**
 * Typed client for the heartbeat automation IPC channels (`db:automation:*`,
 * `automation:approve`). Every failure — including "not found" / invalid
 * schedule — rejects with the main-process message.
 */

import type {
  Automation, AutomationEnvSpec, AutomationInput, AutomationPatch, AutomationRun, AutomationRunEvent,
  AutomationRunWithAutomation, RunLog,
} from "../../../shared/types/automations";
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
  approve: (callId: string, approved: boolean, grant?: "session" | "always") =>
    automation((a) => a.approve(callId, approved, grant)),
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
};
