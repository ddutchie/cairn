/**
 * host-store — the SINGLE adapter between `electron/cordis/` and app I/O.
 *
 * Boundary rule: no file in `electron/cordis/` may import from `../db/*`,
 * `../lib/*`, or `node:child_process` — EXCEPT this file (and its test).
 * Type-only imports (`import type …`) are exempt: they are erased at compile
 * time and cannot smuggle runtime behaviour across the boundary. Everything
 * else the Cordis runtime needs from the host goes through this module:
 *
 *   - `HostStore` — narrow, named operations bound to the existing `db`
 *     handle (workspace meta, note content, git branch, hygiene, usage,
 *     local-LLM endpoint, threads/sessions/todos/plans, approval grants,
 *     and the db-backed tool-executor services). Constructed once per turn
 *     via `createHostStore(db)`; behaviour is byte-identical delegation to
 *     the existing query/lib functions (no query logic lives here).
 *   - `cairnDbPlugin` / `ctx.cairn` channel (extended, not replaced) —
 *     `cairnDbPlugin` now also provides the store under `CAIRN_HOST`
 *     (alongside the raw handle under `CAIRN_DB`); `getHostStore(ctx)`
 *     reads it, falling back to wrapping the provided handle so mounts
 *     that only carry `db` (older callers, unit harnesses) keep working.
 *   - Pure pass-through re-exports below (prompt builders, tool schemas,
 *     risk/secret predicates, logging, id generation, config-cache read).
 *     These are side-effect-free values re-exported here SOLELY so the
 *     cross-boundary import surface stays in one file — no logic, no
 *     wrapping, same references. Import them from `./host-store`, never
 *     from `../lib/*` / `../db/*` directly.
 *
 * Principled notes (deliberately left as-is):
 *   - Type-only `from "../db/…"` / `from "../lib/…"` imports remain across
 *     `electron/cordis/` (LLMConfig, ChatRequest, UsageSource, …). They are
 *     covered by the task's type-only exemption; the verification grep below
 *     still lists them — filter with `grep -v "import type" | grep -v "{ type"`.
 *   - `../notes-files` (writeNoteFile) and `../mcp/tools` (executeMcpTool)
 *     are outside the stated `../db|../lib|child_process` rule and are left
 *     direct; they take the already-injected `db`/`workspacePath` and add no
 *     new boundary surface.
 *   - llama-server lifecycle is WRAPPED (`ensureLocalLlmPort`, dynamic import
 *     preserved) not relocated: adapter pinning stays in session-runtime.ts /
 *     one-shot.ts, which now call the wrapper instead of `../lib/*`.
 *   - usage-recorder's call shape (`RecordUsageArgs`) is a clean passthrough,
 *     so `recordUsage` is a real seam method (plus a db-free standalone for
 *     one-shot callers, which share the recorder's global handle).
 *   - There is no `getCairnSkillContext()` anywhere in the codebase, so no
 *     such seam method exists; skill discovery/loading are pure fs reads
 *     re-exported below, injectable via `createCairnSkillProvider(deps)`.
 *   - `chat-executor.ts` is the app's tool-execution layer colocated in
 *     `cordis/`; its `q.*` calls are now `host.*` calls bound to the same
 *     `db` it already received — same queries, no signature changes.
 *
 * Verification (value imports only; must print nothing):
 *   grep -rn 'from "\.\./db/\|from "\.\./lib/\|node:child_process\|require("\.\./db' \
 *     electron/cordis/ --include="*.ts" | grep -v test | grep -v "host-store.ts" \
 *     | grep -v "import type" | grep -v "{ type"
 */

import type Database from "better-sqlite3";
import type { Context } from "@deepseek-ai/cordis";
import { execSync } from "node:child_process";

import {
  upsertChatThread as upsertChatThreadImpl,
  saveSessionTodos as saveSessionTodosImpl,
  getSessionTodos as getSessionTodosImpl,
  updateCodingSession as updateCodingSessionImpl,
  upsertSessionProfile as upsertSessionProfileImpl,
  getFullSnapshot as getFullSnapshotImpl,
  findLiveNoteByTitle as findLiveNoteByTitleImpl,
  updateCard as updateCardImpl,
  updateNote as updateNoteImpl,
  getUserStyle as getUserStyleImpl,
  appendUserStyleObservation as appendUserStyleObservationImpl,
} from "../db/queries";
import {
  isWorkspaceGranted as isWorkspaceGrantedImpl,
  addWorkspaceApprovalGrant as addWorkspaceApprovalGrantImpl,
} from "../db/approval-grant-queries";
import { recordLlmUsage as recordLlmUsageImpl, type RecordUsageArgs } from "../lib/usage-recorder";
import { migrateLegacyVizDir, ensureGitExcluded, pruneChatArtifacts } from "../lib/artifact-hygiene";
import { getCachedConfig as getCachedConfigImpl } from "../lib/config-cache";
import { generatePrd as generatePrdImpl, type GeneratePrdArgs } from "../lib/prd";
import { executeReadTool as executeReadToolImpl, type CairnSnapshot } from "../lib/read-tools";
import type { LLMConfig } from "../lib/llm";
import type { SessionProfileId } from "../../shared/agent/session-profile";
import type { ApprovalGrant } from "../db/approval-grant-queries";
import type {
  getExternalToolDefs as getExternalToolDefsType,
  executeExternalTool as executeExternalToolType,
} from "../lib/external-tools";

// ── Service keys (owned here; re-exported by cairn-plugins.ts for compat) ────

/** Service key under which cairnDbPlugin provides the Database handle. */
export const CAIRN_DB = "cairnDb";
/** Service key under which cairnDbPlugin provides the HostStore. Same plugin/channel, second key. */
export const CAIRN_HOST = "cairnHost";

// ── Pure pass-through re-exports (no logic — path funnel only, see header) ──

export { newId } from "../db/utils";
export { buildSystemPrompt, withPersonality, TOOL_LABELS, TOOLS } from "../lib/tools";
export { TOOL_SCHEMAS } from "../lib/tool-schemas";
export { dlog, startPhaseTimer } from "../lib/debug-log";
export { toolResultError } from "../lib/tool-result";
export { aiWriteLock } from "../lib/ai-write-lock";
export { CAIRN_APP_IDENTITY } from "../lib/cairn-identity";
export { isSecretFile, bashReferencesSecretFile } from "../lib/coding-tools/secrets";
export { discoverSkills, loadSkill } from "../lib/skills";
export type { SkillMeta, SkillContent } from "../lib/skills";
export { getCachedConfig } from "../lib/config-cache";

// ── Db-free standalone operations (also exposed as HostStore methods) ─────────

/**
 * Current git branch for `cwd`, or undefined when not a repo / git missing.
 * Extracted verbatim from the turn-setup call sites (800ms cap, trim).
 */
export function getGitBranch(cwd: string): string | undefined {
  try {
    return execSync("git branch --show-current", { cwd, encoding: "utf8", timeout: 800 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort workspace artifact hygiene (legacy viz migration, git excludes,
 * chat artifact pruning). Sequential like the original call site; callers keep
 * their own best-effort guards. Never throws for the known fs shapes below —
 * each helper guards internally — but a truly unexpected failure propagates
 * so the caller's guard (not a silent swallow here) decides.
 */
export function runWorkspaceHygiene(workspacePath: string): void {
  migrateLegacyVizDir(workspacePath);
  ensureGitExcluded(workspacePath);
  pruneChatArtifacts(workspacePath, "viz");
}

/** Whether the opt-in dsh schedule overlay is enabled (persisted agent setting). */
export function isScheduleEnabled(): boolean {
  try {
    return getCachedConfigImpl().agentConfig?.scheduleEnabled === true;
  } catch {
    return false;
  }
}

/** Record one usage row for the Usage view. Never throws (recorder guards). */
export function recordUsage(entry: RecordUsageArgs): void {
  recordLlmUsageImpl(entry);
}

/**
 * Ensure the on-device llama-server is running; resolves its port.
 * Dynamic import preserved (llama-server pulls `electron` at module scope).
 */
export async function ensureLocalLlmPort(): Promise<number> {
  const { ensureLlamaServerRunning } = await import("../lib/llama-server");
  return ensureLlamaServerRunning();
}

// ── HostStore ────────────────────────────────────────────────────────────────

export interface WorkspaceMeta {
  workspaceName?: string;
  projectName?: string;
  projectDescription?: string;
}

export interface HostStore {
  // Workspace / notes reads (turn setup + note-updated projection).
  getWorkspaceMeta(workspaceId?: string | null, projectId?: string | null): WorkspaceMeta;
  readNoteContent(noteId: string): string | undefined;
  // Process / fs / config services (no db needed, exposed here for uniformity).
  getGitBranch(cwd: string): string | undefined;
  runWorkspaceHygiene(workspacePath: string): void;
  isScheduleEnabled(): boolean;
  // Usage + local LLM.
  recordUsage(entry: RecordUsageArgs): void;
  ensureLocalLlmPort(): Promise<number>;
  // Threads / sessions / todos / coding plans.
  indexChatThread(threadId: string, workspaceId: string, projectId?: string): void;
  upsertSessionProfile(
    sessionId: string,
    profile: SessionProfileId,
    opts?: { cwd?: string | null; workspaceId?: string | null; projectId?: string | null },
  ): void;
  saveSessionTodos(sessionId: string, todos: Parameters<typeof saveSessionTodosImpl>[2]): void;
  getSessionTodos(sessionId: string): ReturnType<typeof getSessionTodosImpl>;
  updateCodingPlan(sessionId: string, planContent: string): void;
  // Workspace-persistent approval grants.
  isWorkspaceGranted(workspaceId: string, tool: string, target?: string | null): boolean;
  addWorkspaceApprovalGrant(workspaceId: string, tool: string, target?: string | null): ApprovalGrant | null;
  // Tool-executor services (db-bound; same queries the executor ran directly).
  getFullSnapshot(): ReturnType<typeof getFullSnapshotImpl>;
  findLiveNoteByTitle(projectId: string, title: string): ReturnType<typeof findLiveNoteByTitleImpl>;
  updateCard(cardId: string, patch: Parameters<typeof updateCardImpl>[2]): ReturnType<typeof updateCardImpl>;
  updateNote(noteId: string, patch: Parameters<typeof updateNoteImpl>[2]): ReturnType<typeof updateNoteImpl>;
  getUserStyle(): ReturnType<typeof getUserStyleImpl>;
  appendUserStyleObservation(
    section: string | undefined,
    content: string,
  ): ReturnType<typeof appendUserStyleObservationImpl>;
  executeReadTool(
    snap: CairnSnapshot,
    tool: string,
    args: Parameters<typeof executeReadToolImpl>[3],
  ): ReturnType<typeof executeReadToolImpl>;
  generatePrd(
    workspacePath: string,
    args: GeneratePrdArgs,
    llmConfig: LLMConfig,
  ): ReturnType<typeof generatePrdImpl>;
  getExternalToolDefs(
    workspaceId: string,
    projectId: string,
  ): ReturnType<typeof getExternalToolDefsType>;
  executeExternalTool(
    workspaceId: string,
    projectId: string,
    name: string,
    args: Record<string, unknown>,
  ): ReturnType<typeof executeExternalToolType>;
}

/**
 * Bind the store to the existing `db` handle. Construction is cheap
 * (closures only, no I/O) — callers build one per turn from the `db`
 * they already hold.
 */
export function createHostStore(db: Database.Database): HostStore {
  return {
    getWorkspaceMeta(workspaceId?: string | null, projectId?: string | null): WorkspaceMeta {
      // Same two SELECTs the turn-setup call sites ran (the chat path also
      // selected `code_directory` but never used it — omitted here). All keys
      // are always present (possibly undefined) so `{ ...prev, ...meta }`
      // merges erase stale values exactly like the previous explicit
      // `workspace?.name`-style call sites.
      const project = projectId
        ? (db.prepare("SELECT name, description FROM projects WHERE id = ?").get(projectId) as
            | { name?: string; description?: string }
            | undefined)
        : undefined;
      const workspace = workspaceId
        ? (db.prepare("SELECT name FROM workspaces WHERE id = ?").get(workspaceId) as
            | { name?: string }
            | undefined)
        : undefined;
      return {
        workspaceName: workspace?.name,
        projectName: project?.name,
        projectDescription: project?.description,
      };
    },

    readNoteContent(noteId: string): string | undefined {
      const row = db.prepare("SELECT content FROM notes WHERE id = ?").get(noteId) as
        | { content: string }
        | undefined;
      return row ? (row.content ?? "") : undefined;
    },

    getGitBranch(cwd: string): string | undefined {
      return getGitBranch(cwd);
    },

    runWorkspaceHygiene(workspacePath: string): void {
      runWorkspaceHygiene(workspacePath);
    },

    isScheduleEnabled(): boolean {
      return isScheduleEnabled();
    },

    recordUsage(entry: RecordUsageArgs): void {
      recordUsage(entry);
    },

    ensureLocalLlmPort(): Promise<number> {
      return ensureLocalLlmPort();
    },

    indexChatThread(threadId: string, workspaceId: string, projectId?: string): void {
      upsertChatThreadImpl(db, { id: threadId, scope: "workspace", workspaceId, projectId });
    },

    upsertSessionProfile(
      sessionId: string,
      profile: SessionProfileId,
      opts?: { cwd?: string | null; workspaceId?: string | null; projectId?: string | null },
    ): void {
      upsertSessionProfileImpl(db, {
        sessionId,
        profile,
        cwd: opts?.cwd,
        workspaceId: opts?.workspaceId,
        projectId: opts?.projectId,
      });
    },

    saveSessionTodos(sessionId: string, todos: Parameters<typeof saveSessionTodosImpl>[2]): void {
      saveSessionTodosImpl(db, sessionId, todos);
    },

    getSessionTodos(sessionId: string): ReturnType<typeof getSessionTodosImpl> {
      return getSessionTodosImpl(db, sessionId);
    },

    updateCodingPlan(sessionId: string, planContent: string): void {
      updateCodingSessionImpl(db, sessionId, { planContent });
    },

    isWorkspaceGranted(workspaceId: string, tool: string, target?: string | null): boolean {
      return isWorkspaceGrantedImpl(db, workspaceId, tool, target);
    },

    addWorkspaceApprovalGrant(
      workspaceId: string,
      tool: string,
      target?: string | null,
    ): ApprovalGrant | null {
      return addWorkspaceApprovalGrantImpl(db, workspaceId, tool, target);
    },

    getFullSnapshot(): ReturnType<typeof getFullSnapshotImpl> {
      return getFullSnapshotImpl(db);
    },

    findLiveNoteByTitle(projectId: string, title: string): ReturnType<typeof findLiveNoteByTitleImpl> {
      return findLiveNoteByTitleImpl(db, projectId, title);
    },

    updateCard(cardId: string, patch: Parameters<typeof updateCardImpl>[2]): ReturnType<typeof updateCardImpl> {
      return updateCardImpl(db, cardId, patch);
    },

    updateNote(noteId: string, patch: Parameters<typeof updateNoteImpl>[2]): ReturnType<typeof updateNoteImpl> {
      return updateNoteImpl(db, noteId, patch);
    },

    getUserStyle(): ReturnType<typeof getUserStyleImpl> {
      return getUserStyleImpl(db);
    },

    appendUserStyleObservation(
      section: string | undefined,
      content: string,
    ): ReturnType<typeof appendUserStyleObservationImpl> {
      return appendUserStyleObservationImpl(db, section, content);
    },

    executeReadTool(
      snap: CairnSnapshot,
      tool: string,
      args: Parameters<typeof executeReadToolImpl>[3],
    ): ReturnType<typeof executeReadToolImpl> {
      return executeReadToolImpl(db, snap, tool, args);
    },

    generatePrd(
      workspacePath: string,
      args: GeneratePrdArgs,
      llmConfig: LLMConfig,
    ): ReturnType<typeof generatePrdImpl> {
      return generatePrdImpl(db, workspacePath, args, llmConfig);
    },

    async getExternalToolDefs(
      workspaceId: string,
      projectId: string,
    ): ReturnType<typeof getExternalToolDefsType> {
      const { getExternalToolDefs } = await import("../lib/external-tools");
      return getExternalToolDefs(db, workspaceId, projectId);
    },

    async executeExternalTool(
      workspaceId: string,
      projectId: string,
      name: string,
      args: Record<string, unknown>,
    ): ReturnType<typeof executeExternalToolType> {
      const { executeExternalTool } = await import("../lib/external-tools");
      return executeExternalTool(db, workspaceId, projectId, name, args);
    },
  };
}

/**
 * Read the store provided by `cairnDbPlugin` (key `CAIRN_HOST`). Falls back to
 * wrapping the provided raw handle (`CAIRN_DB`) or an explicit `fallbackDb`,
 * so mounts that only carry `db` keep working unchanged. Tolerant of minimal
 * `{ on }`-only test harnesses (no `get`): those resolve via `fallbackDb`.
 */
export function getHostStore(ctx: Context, fallbackDb?: Database.Database): HostStore | undefined {
  const get = (ctx as unknown as { get?: (key: string) => unknown } | null | undefined)?.get;
  const provided = typeof get === "function" ? (get.call(ctx, CAIRN_HOST) as HostStore | undefined) : undefined;
  if (provided) return provided;
  const db = fallbackDb ?? (typeof get === "function" ? (get.call(ctx, CAIRN_DB) as Database.Database | undefined) : undefined);
  return db ? createHostStore(db) : undefined;
}
