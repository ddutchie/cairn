/**
 * Heartbeat automation types shared by the renderer, the Electron main process
 * and the typed IPC contract (`shared/ipc/contract.ts`).
 */

import type { ID } from "./domain";

export type ScheduleKind = "cron" | "every" | "once";

/** An external connector (MCP server / HTTP service) an automation needs in scope. */
export interface AutomationRequirement {
  kind: "mcp" | "service";
  /** Matches the connector's catalog id (slug) or display name, case-insensitive. */
  name: string;
}

/**
 * An automation env var. Non-secret values are stored inline; secret entries
 * keep `value` null and the real value lives in the OS keychain, resolved only
 * in the main process at run time.
 */
export interface AutomationEnv {
  name: string;
  value?: string | null;
  secret: boolean;
}

/** Env var as the env IPC returns it: secrets only say whether they're `set`. */
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
  /** Optional "HH:MM" window — the scheduler only fires runs inside it. */
  activeHoursStart: string | null;
  activeHoursEnd: string | null;
  standingRules: Array<{ tool: string; target?: string }>;
  /**
   * External connectors the automation needs in scope. Empty = data-only
   * automation. Drives the runner's extraTools and the default external-tool
   * approval gating.
   */
  requires: AutomationRequirement[];
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
  /** Absolute path to this run's working folder (<project>/.automations/<id>/runs/<runId>/). */
  runDir: string | null;
  createdAt: string;
}

/** A run joined with its automation's name + project (Overview "Recent run results"). */
export interface AutomationRunWithAutomation extends AutomationRun {
  automationName: string;
  automationProjectId: ID | null;
}

/** `db:automation:create` input. */
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
  requires?: AutomationRequirement[];
  env?: AutomationEnv[];
  /** Provenance when prefilled from the cairn-community catalog. */
  source?: "custom" | "community";
  communityId?: ID | null;
}

/** `db:automation:update` patch; schedule changes recompute `nextRunAt`. */
export type AutomationPatch = Partial<Omit<AutomationInput, "workspaceId">> & { runCount?: number };

/** Installed/attached status of one required connector. */
export interface RequirementStatus extends AutomationRequirement {
  /** A matching connector is installed in the workspace (by catalog id or name). */
  installed: boolean;
  /** Installed AND enabled AND attached to the project (or globally). */
  attached: boolean;
}

/** A file in the automation folder (Develop modal's file panel). */
export interface AutomationFolderFile {
  /** Path relative to the automation folder, posix separators. */
  path: string;
  size: number;
  mtimeMs: number;
}

/** One tool call as it happened — args, outcome, output. */
export interface RunLogTool {
  name: string;
  label?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  output?: string;
  error?: string;
}

/** A persisted per-run transcript — the inspectable record of a run. */
export interface RunLog {
  automationId: string;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  /** The recipe actually executed (manifest instructions, else the row). */
  recipe?: string;
  /** 'done' | 'exhausted' | 'error'. */
  status?: string;
  error?: string | null;
  /** Streaming assistant tokens accumulated during the run. */
  tokens?: string;
  /** Streaming reasoning accumulated during the run. */
  thoughts?: string;
  /** Every tool call in order. */
  tools: RunLogTool[];
}

/** Live run activity pushed on `automation:run` (the "watch this run" view). */
export interface AutomationRunEvent {
  event: "started" | "token" | "thought" | "tool" | "toolDone" | "toolConfirmRequired" | "approval" | "finished";
  automationId: string;
  runId: string;
  delta?: string;
  tool?: string;
  label?: string;
  args?: Record<string, unknown>;
  status?: "start" | "end";
  ok?: boolean;
  output?: string;
  error?: string;
  recipe?: string;
  content?: string;
  exhausted?: boolean;
  callId?: string;
}
