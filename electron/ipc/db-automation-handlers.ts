/** Heartbeat automations: CRUD, runs, folder/manifest, env vars. Split out of db-handlers.ts. */

import { registerContractHandle, broadcastEvent } from "./registry";
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
  getAutomationDailyBudget,
  setAutomationDailyBudget,
  automationSpendSince,
  type AutomationEnv,
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
  registerContractHandle("db:automation:list", (_e, { workspaceId }) => handle(() => listAutomations(ctx.db, workspaceId)));
  registerContractHandle("db:automation:get", (_e, { id }) => handle(() => getAutomationById(ctx.db, id)));
  registerContractHandle("db:automation:create", (_e, input) => handle(() => {
    let nextRunAt = input.nextRunAt;
    if (!nextRunAt) {
      try {
        const next = computeNextRun(parseSchedule(input.scheduleExpr), new Date(), input.timezone ?? undefined);
        // A schedule with no future occurrence (e.g. a 'once' in the past) is
        // created disabled rather than "due now" (which would fire once then
        // disable itself).
        if (!next) throw new Error("Schedule has no future run time.");
        nextRunAt = next.toISOString();
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : "Invalid schedule expression.");
      }
    }
    return createAutomation(ctx.db, { ...input, nextRunAt });
  }));
  registerContractHandle("db:automation:update", (_e, { id, patch }) => handle(() => {
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
  registerContractHandle("db:automation:delete", (_e, { id }) => handle(() => {
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
  registerContractHandle("db:automation:runs", (_e, { automationId, limit }) => handle(() => listAutomationRuns(ctx.db, automationId, limit)));
  registerContractHandle("db:automation:recentRuns", (_e, { workspaceId, projectId, limit }) => handle(() => listRecentAutomationRuns(ctx.db, workspaceId, projectId ?? null, limit ?? 10)));
  registerContractHandle("db:automation:runningCount", () => handle(() => countRunningAutomationRuns(ctx.db)));
  registerContractHandle("db:automation:checkRequirements", (_e, { workspaceId, projectId, requires }) =>
    handle(() => checkRequirements(ctx.db, workspaceId, projectId ?? "", requires)),
  );
  registerContractHandle("db:automation:budget:get", () => handle(() => {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    return { budgetUsd: getAutomationDailyBudget(ctx.db), spentTodayUsd: automationSpendSince(ctx.db, dayStart.getTime()) };
  }));
  registerContractHandle("db:automation:budget:set", (_e, { usd }) =>
    handle(() => ({ budgetUsd: setAutomationDailyBudget(ctx.db, typeof usd === "number" ? usd : null) })));
  registerContractHandle("db:automation:runNow", (_e, { id }) => handle(() => {
    const runId = runAutomationNow({
      db: ctx.db,
      workspacePath: ctx.workspacePath,
      send: (channel, payload) => broadcastEvent(channel, payload),
    }, id);
    return runId === null ? { skipped: true as const } : { runId };
  }));

  // Resolve a pending tool approval for a running automation (Cordis engine).
  // The renderer fires this when the user approves/denies a gated tool; it
  // resolves the coding agent's approval seam. grant "session" remembers for
  // the turn; "always" persists an "always allow" standing rule on the automation.
  // A handle (not ipcMain.on): preload invokes it, and an invoke never reaches
  // an `on` listener — approvals from the run watcher used to be dropped.
  registerContractHandle("automation:approve", (_e, { callId, approved, grant }) =>
    handle(() => resolveAutomationApproval(callId, approved, grant)));

  // The automation's folder on disk (<project>/.automations/<id>/) — the dev
  // agent's cwd when building/testing the automation's scripts. The folder is
  // CREATED here (scripts/ + out/ + .env + manifest) so a Develop session on a
  // never-run automation sees a real, populated workspace.
  registerContractHandle("db:automation:folder", (_e, { id }) => handle(() => {
    const a = getAutomationById(ctx.db, id);
    if (!a) throw new Error("Automation not found.");
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
  registerContractHandle("db:automation:files", (_e, { id }) => handle(() => {
    const a = getAutomationById(ctx.db, id);
    if (!a) throw new Error("Automation not found.");
    const projectName = a.projectId ? getProjectName(ctx.db, a.projectId) : null;
    const folder = automationFolderDir(ctx.workspacePath, a.id, projectName);
    return { files: listAutomationFolderFiles(folder) };
  }));

  // A run's persisted transcript (run-log.json in its run folder).
  registerContractHandle("db:automation:runLog", (_e, { runId }) => handle(() => {
    const run = getAutomationRunById(ctx.db, runId);
    if (!run || !run.runDir) throw new Error("No run folder for this run.");
    const log = readRunLog(run.runDir);
    if (!log) throw new Error("No run transcript saved for this run.");
    return { log };
  }));

  // Apply the agent-authored manifest.json (instructions / env schema / standing
  // rules) back onto the automation row — the Develop loop's "write the resulting
  // automation shape" step.
  registerContractHandle("db:automation:syncFromManifest", (_e, { id }) => handle(() => {
    const a = getAutomationById(ctx.db, id);
    if (!a) throw new Error("Automation not found.");
    const projectName = a.projectId ? getProjectName(ctx.db, a.projectId) : null;
    const folder = automationFolderDir(ctx.workspacePath, a.id, projectName);
    const manifest = readAutomationManifest(folder);
    if (!manifest) throw new Error("No manifest.json in the automation folder — run Develop first.");
    // Map the manifest onto the row: instructions / env / standing rules
    // (sanitised — target-less run_script/bash rules are dropped) / requires.
    const { patch, dropped } = applyManifestToAutomation(a, manifest);
    const updated = updateAutomation(ctx.db, id, patch);
    if (!updated) throw new Error("Failed to sync automation from manifest.");
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

  registerContractHandle("db:automation:env", (_e, { automationId }) => handle(() => {
    const a = getAutomationById(ctx.db, automationId);
    if (!a) throw new Error("Automation not found.");
    return envSpec(a);
  }));

  registerContractHandle("db:automation:env:set", (_e, { automationId, name, value, secret }) => handle(() => {
    if (!isValidEnvName(name)) {
      throw new Error(`Invalid env var name "${name}" — use only letters, digits and underscores.`);
    }
    const a = getAutomationById(ctx.db, automationId);
    if (!a) throw new Error("Automation not found.");
    if (secret) {
      // Secret → keychain only; the row keeps the name + flag with a null value.
      try {
        setSecret("automation", automationId, name, value);
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : "Failed to store secret.");
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

  registerContractHandle("db:automation:env:delete", (_e, { automationId, name }) => handle(() => {
    const a = getAutomationById(ctx.db, automationId);
    if (!a) throw new Error("Automation not found.");
    deleteSecret("automation", automationId, name);
    updateAutomation(ctx.db, automationId, { env: a.env.filter((e) => e.name !== name) });
    const updated = getAutomationById(ctx.db, automationId);
    return updated ? envSpec(updated) : [];
  }));

  // Friendly schedule preview — compute the next fire time for a proposed
  // schedule expression (used by the Automations schedule builder).
  registerContractHandle("db:automation:preview", (_e, { scheduleExpr, timezone }) => handle(() => {
    try {
      const next = computeNextRun(parseSchedule(scheduleExpr), new Date(), timezone ?? undefined);
      return { nextRunAt: next ? next.toISOString() : null };
    } catch (err) {
      throw new Error(errMsg(err));
    }
  }));
}
