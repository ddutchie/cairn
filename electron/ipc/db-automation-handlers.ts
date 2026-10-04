/** Heartbeat automations: CRUD, runs, folder/manifest, env vars. Split out of db-handlers.ts. */

import { registerIpcHandle, registerIpcOn, broadcastEvent } from "./registry";
import { handle, getProjectName, type DbContext } from "./result-helpers";
import * as q from "../db/queries";
import {
  createAutomation,
  getAutomationById,
  getAutomationRunById,
  listAutomations,
  updateAutomation,
  listAutomationRuns,
  listRecentAutomationRuns,
  countRunningAutomationRuns,
  type AutomationEnv,
  type AutomationInput,
} from "../db/automation-queries";
import { runAutomationNow, resolveAutomationApproval } from "../lib/heartbeat-runner";
import { checkRequirements } from "../lib/external-tools";
import { parseSchedule, computeNextRun } from "../lib/automation-schedule";
import { automationFolderDir, ensureAutomationDir, listAutomationFolderFiles, readRunLog } from "../lib/automation-folder";
import { deleteAutomationWithCleanup } from "../lib/automation-delete";
import { applyManifestToAutomation, isValidEnvName, prepareAutomationFolder, readAutomationManifest } from "../lib/automation-env";
import { hasSecret, setSecret, deleteSecret } from "../lib/secure-store";
import { errMsg } from "../host-shared/errors";

export function registerAutomationHandlers(ctx: DbContext): void {
  // ── Heartbeat automations ─────────────────────────
  registerIpcHandle("db:automation:list", (_e, { workspaceId }) => handle(() => listAutomations(ctx.db, workspaceId)));
  registerIpcHandle("db:automation:get", (_e, { id }) => handle(() => getAutomationById(ctx.db, id)));
  registerIpcHandle("db:automation:create", (_e, args: AutomationInput) => handle(() => {
    const input = { ...args };
    if (!input.nextRunAt) {
      try {
        const next = computeNextRun(parseSchedule(input.scheduleExpr), new Date(), input.timezone ?? undefined);
        // A schedule with no future occurrence (e.g. a 'once' in the past) is
        // created disabled rather than "due now" (which would fire once then
        // disable itself).
        if (!next) return { error: "Schedule has no future run time." };
        input.nextRunAt = next.toISOString();
      } catch (err) {
        return { error: err instanceof Error ? err.message : "Invalid schedule expression." };
      }
    }
    return createAutomation(ctx.db, input);
  }));
  registerIpcHandle("db:automation:update", (_e, { id, patch }: { id: string; patch: Partial<Omit<AutomationInput, "workspaceId">> }) => handle(() => {
    // Recompute next_run_at when the schedule/timezone changes.
    if (patch.scheduleKind !== undefined || patch.scheduleExpr !== undefined || patch.timezone !== undefined) {
      const existing = getAutomationById(ctx.db, id);
      if (existing) {
        const expr = patch.scheduleExpr ?? existing.scheduleExpr;
        const tz = patch.timezone === undefined ? existing.timezone : patch.timezone;
        try {
          const next = computeNextRun(parseSchedule(expr), new Date(), tz ?? undefined);
          // No future occurrence → leave next_run_at untouched (matches the
          // invalid-expression catch below); the automation disables on its
          // next tick rather than being stamped "due now".
          if (next) patch.nextRunAt = next.toISOString();
        } catch {
          // Invalid schedule — leave next_run_at unchanged; the update still proceeds.
        }
      }
    }
    return updateAutomation(ctx.db, id, patch);
  }));
  registerIpcHandle("db:automation:delete", (_e, { id }) => handle(() => {
    // Retry-safe ordering (issue #133): the DB row is the only handle back to
    // the automation's folder + keychain secrets, so both cleanups must succeed
    // BEFORE the row is removed. A cleanup failure throws (surfaced as
    // { error } by handle()), the row is kept, and a later delete retries.
    // The resolver is strict: an unresolvable project throws rather than
    // falling back to the workspace folder (which would delete the row while
    // the real project folder remains).
    return deleteAutomationWithCleanup(ctx.db, ctx.workspacePath, id, {
      projectNameFor: (projectId) => {
        const project = q.getProjectById(ctx.db, projectId);
        if (!project) {
          throw new Error(`project ${projectId} was not found`);
        }
        return project.name;
      },
    });
  }));
  registerIpcHandle("db:automation:runs", (_e, { automationId, limit }: { automationId: string; limit?: number }) => handle(() => listAutomationRuns(ctx.db, automationId, limit)));
  registerIpcHandle("db:automation:recentRuns", (_e, { workspaceId, projectId, limit }: { workspaceId: string; projectId?: string | null; limit?: number }) => handle(() => listRecentAutomationRuns(ctx.db, workspaceId, projectId ?? null, limit ?? 10)));
  registerIpcHandle("db:automation:runningCount", () => handle(() => countRunningAutomationRuns(ctx.db)));
  registerIpcHandle("db:automation:checkRequirements", (_e, { workspaceId, projectId, requires }: { workspaceId: string; projectId?: string | null; requires: Array<{ kind: "mcp" | "service"; name: string }> }) =>
    handle(() => checkRequirements(ctx.db, workspaceId, projectId ?? "", requires)),
  );
  registerIpcHandle("db:automation:runNow", (_e, { id }) => handle(() => {
    const runId = runAutomationNow({
      db: ctx.db,
      workspacePath: ctx.workspacePath,
      send: (channel, payload) => broadcastEvent(channel, payload),
    }, id);
    return runId === null ? { skipped: true } : { runId };
  }));

  // Resolve a pending tool approval for a running automation (Cordis engine).
  // The renderer fires this when the user approves/denies a gated tool; it
  // resolves the coding agent's approval seam. grant "session" remembers for
  // the turn; "always" persists an "always allow" standing rule on the automation.
  registerIpcOn("automation:approve", (_e, { callId, approved, grant }: { callId: string; approved: boolean; grant?: "session" | "always" }) => {
    resolveAutomationApproval(callId, approved, grant);
  });

  // The automation's folder on disk (<project>/.automations/<id>/) — the dev
  // agent's cwd when building/testing the automation's scripts. The folder is
  // CREATED here (scripts/ + out/ + .env + manifest) so a Develop session on a
  // never-run automation sees a real, populated workspace.
  registerIpcHandle("db:automation:folder", (_e, { id }: { id: string }) => handle(() => {
    const a = getAutomationById(ctx.db, id);
    if (!a) return { error: "Automation not found." };
    const projectName = a.projectId ? getProjectName(ctx.db, a.projectId) : null;
    const folder = automationFolderDir(ctx.workspacePath, a.id, projectName);
    try {
      ensureAutomationDir(folder);
      prepareAutomationFolder(folder, a);
    } catch (err) {
      console.warn("[automation] failed to prepare develop folder:", err);
    }
    return { folder };
  }));

  // File tree of the automation folder — for the Develop modal's "files" panel.
  registerIpcHandle("db:automation:files", (_e, { id }: { id: string }) => handle(() => {
    const a = getAutomationById(ctx.db, id);
    if (!a) return { error: "Automation not found." };
    const projectName = a.projectId ? getProjectName(ctx.db, a.projectId) : null;
    const folder = automationFolderDir(ctx.workspacePath, a.id, projectName);
    return { files: listAutomationFolderFiles(folder) };
  }));

  // A run's persisted transcript (run-log.json in its run folder).
  registerIpcHandle("db:automation:runLog", (_e, { runId }: { runId: string }) => handle(() => {
    const run = getAutomationRunById(ctx.db, runId);
    if (!run || !run.runDir) return { error: "No run folder for this run." };
    const log = readRunLog(run.runDir);
    if (!log) return { error: "No run transcript saved for this run." };
    return { log };
  }));

  // Apply the agent-authored manifest.json (instructions / env schema / standing
  // rules) back onto the automation row — the Develop loop's "write the resulting
  // automation shape" step.
  registerIpcHandle("db:automation:syncFromManifest", (_e, { id }: { id: string }) => handle(() => {
    const a = getAutomationById(ctx.db, id);
    if (!a) return { error: "Automation not found." };
    const projectName = a.projectId ? getProjectName(ctx.db, a.projectId) : null;
    const folder = automationFolderDir(ctx.workspacePath, a.id, projectName);
    const manifest = readAutomationManifest(folder);
    if (!manifest) return { error: "No manifest.json in the automation folder — run Develop first." };
    // Map the manifest onto the row: instructions / env / standing rules
    // (sanitised — target-less run_script/bash rules are dropped) / requires.
    const { patch, dropped } = applyManifestToAutomation(a, manifest);
    const updated = updateAutomation(ctx.db, id, patch);
    if (!updated) return { error: "Failed to sync automation from manifest." };
    return { automation: updated, dropped };
  }));

  // ── Automation env vars ──────────────────────────────────────────────────
  // Non-secret values are stored inline on the automation row; secret values
  // live in the OS keychain (kind "automation") and are NEVER returned to the
  // renderer — only a "set" boolean is exposed.
  const envSpec = (a: { id: string; env: AutomationEnv[] }) =>
    a.env.map((e) => e.secret
      ? { name: e.name, secret: true, set: hasSecret("automation", a.id, e.name) }
      : { name: e.name, secret: false, value: e.value ?? "" });

  registerIpcHandle("db:automation:env", (_e, { automationId }: { automationId: string }) => handle(() => {
    const a = getAutomationById(ctx.db, automationId);
    if (!a) return { error: "Automation not found." };
    return envSpec(a);
  }));

  registerIpcHandle("db:automation:env:set", (_e, { automationId, name, value, secret }: { automationId: string; name: string; value: string; secret: boolean }) => handle(() => {
    if (!isValidEnvName(name)) {
      return { error: `Invalid env var name "${name}" — use only letters, digits and underscores.` };
    }
    const a = getAutomationById(ctx.db, automationId);
    if (!a) return { error: "Automation not found." };
    if (secret) {
      // Secret → keychain only; the row keeps the name + flag with a null value.
      try {
        setSecret("automation", automationId, name, value);
      } catch (err) {
        return { error: err instanceof Error ? err.message : "Failed to store secret." };
      }
      updateAutomation(ctx.db, automationId, {
        env: [...a.env.filter((e) => e.name !== name), { name, secret: true }],
      });
    } else {
      updateAutomation(ctx.db, automationId, {
        env: [...a.env.filter((e) => e.name !== name), { name, secret: false, value }],
      });
    }
    const updated = getAutomationById(ctx.db, automationId);
    return updated ? envSpec(updated) : [];
  }));

  registerIpcHandle("db:automation:env:delete", (_e, { automationId, name }: { automationId: string; name: string }) => handle(() => {
    const a = getAutomationById(ctx.db, automationId);
    if (!a) return { error: "Automation not found." };
    deleteSecret("automation", automationId, name);
    updateAutomation(ctx.db, automationId, { env: a.env.filter((e) => e.name !== name) });
    const updated = getAutomationById(ctx.db, automationId);
    return updated ? envSpec(updated) : [];
  }));

  // Friendly schedule preview — compute the next fire time for a proposed
  // schedule expression (used by the Automations schedule builder).
  registerIpcHandle("db:automation:preview", (_e, { scheduleExpr, timezone }: { scheduleKind?: string; scheduleExpr: string; timezone?: string | null }) => handle(() => {
    try {
      const next = computeNextRun(parseSchedule(scheduleExpr), new Date(), timezone ?? undefined);
      return { nextRunAt: next ? next.toISOString() : null };
    } catch (err) {
      return { error: errMsg(err) };
    }
  }));
}
