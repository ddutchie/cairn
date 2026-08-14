/**
 * Cairn — Heartbeat automation queries
 *
 * CRUD + scheduler-facing queries for the `automations` / `automation_runs`
 * tables (migration v32). Device-local, workspace-scoped, mirroring the
 * slash_commands pattern. Re-usable by the main-process scheduler and the
 * renderer (via IPC) — never constructs its own Database handle.
 */

import type Database from "better-sqlite3";
import { newId, ts } from "./utils";

export interface AutomationRequirement {
  kind: "mcp" | "service";
  name: string;
}

/**
 * An automation env var. Non-secret values are stored inline; secret entries
 * keep `value` null and the real value lives in the OS keychain (secure-store,
 * kind "automation"), resolved only in the main process at run time.
 */
export interface AutomationEnv {
  name: string;
  value?: string | null;
  secret: boolean;
}

export interface Automation {
  id: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  description: string;
  instructions: string;
  scheduleKind: "cron" | "every" | "once";
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
   * External connectors (MCP servers / HTTP services) the automation needs in
   * scope. Empty = data-only automation. Drives the runner's extraTools and the
   * default external-tool approval gating.
   */
  requires: AutomationRequirement[];
  /** Env vars exposed to scripts; secrets live in the keychain, not here. */
  env: AutomationEnv[];
  source: "custom" | "community";
  communityId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AutomationRunStatus = "pending" | "running" | "done" | "denied" | "error" | "skipped";

export interface AutomationRun {
  id: string;
  automationId: string;
  status: AutomationRunStatus;
  resultNoteId: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  scratch: string | null;
  /** Absolute path to this run's working folder (<project>/.automations/<id>/runs/<runId>/). */
  runDir: string | null;
  createdAt: string;
}

type Row = Record<string, unknown>;

function toAutomation(r: Row): Automation {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    projectId: r.project_id ? String(r.project_id) : null,
    name: String(r.name),
    description: String(r.description ?? ""),
    instructions: String(r.instructions),
    scheduleKind: r.schedule_kind as Automation["scheduleKind"],
    scheduleExpr: String(r.schedule_expr),
    timezone: r.timezone ? String(r.timezone) : null,
    nextRunAt: String(r.next_run_at),
    enabled: Boolean(r.enabled),
    maxRuns: r.max_runs === null || r.max_runs === undefined ? null : Number(r.max_runs),
    runCount: Number(r.run_count),
    approvalMode: r.approval_mode === "ask" ? "ask" : "auto",
    activeHoursStart: r.active_hours_start ? String(r.active_hours_start) : null,
    activeHoursEnd: r.active_hours_end ? String(r.active_hours_end) : null,
    standingRules: parseJson<Array<{ tool: string; target?: string }>>(r.standing_rules, []),
    requires: parseJson<AutomationRequirement[]>(r.requires, []),
    env: parseJson<AutomationEnv[]>(r.env, []),
    source: r.source as Automation["source"],
    communityId: r.community_id ? String(r.community_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toRun(r: Row): AutomationRun {
  return {
    id: String(r.id),
    automationId: String(r.automation_id),
    status: r.status as AutomationRunStatus,
    resultNoteId: r.result_note_id ? String(r.result_note_id) : null,
    startedAt: String(r.started_at),
    finishedAt: r.finished_at ? String(r.finished_at) : null,
    error: r.error ? String(r.error) : null,
    scratch: r.scratch ? String(r.scratch) : null,
    runDir: r.run_dir ? String(r.run_dir) : null,
    createdAt: String(r.created_at),
  };
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface AutomationInput {
  workspaceId: string;
  projectId?: string | null;
  name: string;
  description?: string;
  instructions: string;
  scheduleKind: Automation["scheduleKind"];
  scheduleExpr: string;
  nextRunAt: string;
  timezone?: string | null;
  enabled?: boolean;
  maxRuns?: number | null;
  runCount?: number;
  approvalMode?: "auto" | "ask";
  activeHoursStart?: string | null;
  activeHoursEnd?: string | null;
  standingRules?: Array<{ tool: string; target?: string }>;
  requires?: AutomationRequirement[];
  env?: AutomationEnv[];
  source?: "custom" | "community";
  communityId?: string | null;
}

export function createAutomation(db: Database.Database, input: AutomationInput): Automation {
  const id = newId();
  const now = ts();
  db.prepare(`
    INSERT INTO automations (
      id, workspace_id, project_id, name, description, instructions,
      schedule_kind, schedule_expr, timezone, next_run_at, enabled, max_runs,
      run_count, approval_mode, active_hours_start, active_hours_end, standing_rules, requires, env, source, community_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.workspaceId, input.projectId ?? null, input.name, input.description ?? "",
    input.instructions, input.scheduleKind, input.scheduleExpr, input.timezone ?? null,
    input.nextRunAt, input.enabled === false ? 0 : 1, input.maxRuns ?? null,
    input.runCount ?? 0, input.approvalMode ?? "auto", input.activeHoursStart ?? null,
    input.activeHoursEnd ?? null, JSON.stringify(input.standingRules ?? []),
    JSON.stringify(input.requires ?? []),
    JSON.stringify(input.env ?? []),
    input.source ?? "custom", input.communityId ?? null, now, now,
  );
  return getAutomationById(db, id)!;
}

export function getAutomationById(db: Database.Database, id: string): Automation | null {
  const r = db.prepare("SELECT * FROM automations WHERE id = ?").get(id) as Row | undefined;
  return r ? toAutomation(r) : null;
}

export function listAutomations(db: Database.Database, workspaceId: string): Automation[] {
  const rows = db
    .prepare("SELECT * FROM automations WHERE workspace_id = ? ORDER BY created_at ASC")
    .all(workspaceId) as Row[];
  return rows.map(toAutomation);
}

export function updateAutomation(
  db: Database.Database,
  id: string,
  patch: Partial<Omit<AutomationInput, "workspaceId">>,
): Automation | null {
  const existing = getAutomationById(db, id);
  if (!existing) return null;
  const now = ts();
  const set: string[] = [];
  const params: unknown[] = [];
  const fields: Record<string, unknown> = {
    project_id: patch.projectId === undefined ? undefined : patch.projectId,
    name: patch.name,
    description: patch.description,
    instructions: patch.instructions,
    schedule_kind: patch.scheduleKind,
    schedule_expr: patch.scheduleExpr,
    timezone: patch.timezone === undefined ? undefined : patch.timezone,
    next_run_at: patch.nextRunAt,
    enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0,
    max_runs: patch.maxRuns === undefined ? undefined : patch.maxRuns,
    approval_mode: patch.approvalMode === undefined ? undefined : patch.approvalMode,
    active_hours_start: patch.activeHoursStart === undefined ? undefined : patch.activeHoursStart,
    active_hours_end: patch.activeHoursEnd === undefined ? undefined : patch.activeHoursEnd,
    standing_rules: patch.standingRules === undefined ? undefined : JSON.stringify(patch.standingRules),
    requires: patch.requires === undefined ? undefined : JSON.stringify(patch.requires),
    env: patch.env === undefined ? undefined : JSON.stringify(patch.env),
    source: patch.source,
    community_id: patch.communityId === undefined ? undefined : patch.communityId,
  };
  for (const [col, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    set.push(`${col} = ?`);
    params.push(val);
  }
  if (set.length === 0) return existing;
  set.push("updated_at = ?");
  params.push(now);
  db.prepare(`UPDATE automations SET ${set.join(", ")} WHERE id = ?`).run(...params, id);
  return getAutomationById(db, id);
}

export function deleteAutomation(db: Database.Database, id: string): boolean {
  // ON DELETE CASCADE removes the run history too.
  const info = db.prepare("DELETE FROM automations WHERE id = ?").run(id);
  return info.changes > 0;
}

/**
 * Automations that are enabled and due at-or-before `nowIso`, ordered soonest first.
 * Used by the scheduler tick.
 */
export function listDueAutomations(db: Database.Database, nowIso: string): Automation[] {
  const rows = db
    .prepare("SELECT * FROM automations WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC")
    .all(nowIso) as Row[];
  return rows.map(toAutomation);
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export function createAutomationRun(
  db: Database.Database,
  automationId: string,
  status: AutomationRunStatus = "pending",
): AutomationRun {
  const id = newId();
  const now = ts();
  db.prepare(`
    INSERT INTO automation_runs (id, automation_id, status, started_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, automationId, status, now, now);
  return getAutomationRunById(db, id)!;
}

export function getAutomationRunById(db: Database.Database, id: string): AutomationRun | null {
  const r = db.prepare("SELECT * FROM automation_runs WHERE id = ?").get(id) as Row | undefined;
  return r ? toRun(r) : null;
}

export function updateAutomationRun(
  db: Database.Database,
  id: string,
  patch: Partial<{ status: AutomationRunStatus; resultNoteId: string | null; finishedAt: string | null; error: string | null; scratch: string | null; runDir: string | null }>,
): AutomationRun | null {
  const now = ts();
  const set: string[] = [];
  const params: unknown[] = [];
  const fields: Record<string, unknown> = {
    status: patch.status,
    result_note_id: patch.resultNoteId === undefined ? undefined : patch.resultNoteId,
    finished_at: patch.finishedAt === undefined ? undefined : patch.finishedAt,
    error: patch.error === undefined ? undefined : patch.error,
    scratch: patch.scratch === undefined ? undefined : patch.scratch,
    run_dir: patch.runDir === undefined ? undefined : patch.runDir,
  };
  for (const [col, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    set.push(`${col} = ?`);
    params.push(val);
  }
  if (set.length === 0) return getAutomationRunById(db, id);

  // Auto-set finished_at only when this update transitions the run to a
  // terminal status and the caller didn't supply its own timestamp. Scratch /
  // currentTool updates during a running run must NOT stamp finished_at.
  const TERMINAL = new Set<AutomationRunStatus>(["done", "denied", "error", "skipped"]);
  const autoFinish = patch.finishedAt === undefined && patch.status !== undefined && TERMINAL.has(patch.status);
  const sql = `UPDATE automation_runs SET ${set.join(", ")}${autoFinish ? ", finished_at = COALESCE(finished_at, ?)" : ""} WHERE id = ?`;
  db.prepare(sql).run(...(autoFinish ? [...params, now, id] : [...params, id]));
  return getAutomationRunById(db, id);
}

export function listAutomationRuns(db: Database.Database, automationId: string, limit = 50): AutomationRun[] {
  const rows = db
    .prepare("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(automationId, limit) as Row[];
  return rows.map(toRun);
}

/**
 * A run row joined with its parent automation's name + project, for the
 * Overview "Recent run results" feed. The feed lives on the project
 * Overview and needs the automation name to render each row without an
 * N+1 lookup by the renderer.
 */
export interface AutomationRunWithAutomation extends AutomationRun {
  automationName: string;
  automationProjectId: string | null;
}

/**
 * Recent runs across all automations scoped to `workspaceId` (and an optional
 * `projectId` for the project Overview's run-results feed). Joins
 * `automation_runs` to `automations` to surface the automation name in the
 * same query, ordered newest-finished (or started, for in-flight runs) first.
 *
 * Scope is project-scoped automations only when `projectId` is supplied —
 * workspace-scoped automations (project_id IS NULL) are intentionally NOT
 * surfaced on a project's Overview, since they don't belong to any one
 * project. The dedicated Automations view shows those.
 */
export function listRecentAutomationRuns(
  db: Database.Database,
  workspaceId: string,
  projectId?: string | null,
  limit = 10,
): AutomationRunWithAutomation[] {
  const sql = projectId
    ? `SELECT r.*, a.name AS automation_name, a.project_id AS automation_project_id
       FROM automation_runs r
       JOIN automations a ON r.automation_id = a.id
       WHERE a.workspace_id = ? AND a.project_id = ?
       ORDER BY r.started_at DESC, r.created_at DESC, r.rowid DESC
       LIMIT ?`
    : `SELECT r.*, a.name AS automation_name, a.project_id AS automation_project_id
       FROM automation_runs r
       JOIN automations a ON r.automation_id = a.id
       WHERE a.workspace_id = ?
       ORDER BY r.started_at DESC, r.created_at DESC, r.rowid DESC
       LIMIT ?`;
  const params = projectId ? [workspaceId, projectId, limit] : [workspaceId, limit];
  const rows = db.prepare(sql).all(...params) as Row[];
  return rows.map((r) => ({
    ...toRun(r),
    automationName: String(r.automation_name),
    automationProjectId: r.automation_project_id ? String(r.automation_project_id) : null,
  }));
}

/**
 * True when the automation already has an in-flight run (status running/pending).
 * Used by the scheduler's skip-on-overlap policy so a slow run never stacks.
 */
export function hasInFlightRun(db: Database.Database, automationId: string): boolean {
  const r = db
    .prepare("SELECT id FROM automation_runs WHERE automation_id = ? AND status IN ('pending','running') LIMIT 1")
    .get(automationId) as Row | undefined;
  return Boolean(r);
}

/** Count of runs currently in flight (for the title-bar "automations running" bar). */
export function countRunningAutomationRuns(db: Database.Database): number {
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM automation_runs WHERE status IN ('pending','running')")
    .get() as { n: number };
  return r.n;
}

/**
 * Mark every run still stuck in 'pending'/'running' as interrupted. Runs are
 * only in-flight while the app is open — if the process died mid-run (crash,
 * quit during a turn, dev reload) the row stays 'running' forever, and the
 * scheduler's skip-on-overlap guard then blocks that automation from ever
 * firing again. Called once at startup (and on workspace reinitialise) to
 * recover them. Returns the number of runs recovered.
 */
export function recoverInterruptedRuns(
  db: Database.Database,
  error = "Interrupted — the app closed while this run was in flight.",
): number {
  const rows = db
    .prepare("SELECT id FROM automation_runs WHERE status IN ('pending','running')")
    .all() as Row[];
  if (rows.length === 0) return 0;
  const update = db.prepare(
    "UPDATE automation_runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?",
  );
  const now = ts();
  for (const r of rows) update.run(error, now, r.id);
  return rows.length;
}

/** Increment the automation's run_count. */
export function bumpAutomationRunCount(db: Database.Database, id: string): void {
  db.prepare("UPDATE automations SET run_count = run_count + 1, updated_at = ? WHERE id = ?").run(ts(), id);
}
