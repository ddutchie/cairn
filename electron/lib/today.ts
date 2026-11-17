/**
 * Today: the built-in automation behind the Today view.
 *
 * One automation row per workspace (`projectId` null), marked with
 * `communityId = TODAY_COMMUNITY_ID`. It runs through the normal heartbeat
 * runner (schedule, run log, run history), which for Today:
 *   - offers only read-only tools plus the brief tools (`today-tools.ts`), and
 *     answers every ask itself, so an unattended 07:00 run never waits on the
 *     user and never changes anything outside the brief;
 *   - reads the connectors of every included project (plus global ones),
 *     minus the apps the user turned off;
 *   - gives the model Cairn's own project facts (`today-facts.ts`).
 * The brief is saved after every brief tool call under the automation's
 * durable `out/today/<date>.json`; `today.json` in the folder holds the
 * settings.
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Automation } from "../../shared/types/automations";
import {
  DEFAULT_TODAY_SETTINGS, TODAY_COMMUNITY_ID, parseTodayBrief, parseTodayCron, todayCron,
  type TodayBrief, type TodaySettings, type TodayState,
} from "../../shared/today/brief";
import { isCairnReadTool, isExternalToolName } from "../../shared/agent/tool-names";
import { READ_VERB, WRITE_VERB, operationWords, toolServer } from "../../shared/today/route";
import {
  createAutomation, deleteAutomation, getAutomationById, hasInFlightRun, listAutomationRuns, listAutomations, updateAutomation,
} from "../db/automation-queries";
import { getProjects } from "../db/workspace-queries";
import { automationFolderDir, automationOutDir, readRunLog } from "./automation-folder";
import { computeNextRun, parseSchedule } from "./automation-schedule";
import { listScopedConnectors } from "./external-tools";
import { factsForPrompt, projectFacts } from "./today-facts";
import { isTodayBriefTool } from "./today-tools";

export function isTodayAutomation(a: Pick<Automation, "communityId">): boolean {
  return a.communityId === TODAY_COMMUNITY_ID;
}

/** The workspace's Today row. */
export function findTodayAutomation(db: Database.Database, workspaceId: string): Automation | null {
  return listAutomations(db, workspaceId).find((a) => isTodayAutomation(a) && !a.projectId) ?? null;
}

/** Engine tools that only read (files in the run folder, the web). */
const ENGINE_READ_TOOLS = new Set([
  "read", "read_image", "grep", "glob", "web_fetch", "skill", "todo_write", "codebase_query",
  "read_mcp_resource", "list_mcp_resources", "list_mcp_resource_templates",
]);

/**
 * Today's read-only policy. Built-in reads and the brief tools pass; a
 * connector tool passes when its operation name reads like a read
 * (`mcp__slack__search_messages`, `mcp__workiq__ask`). Everything else is
 * denied.
 *
 * Connector tools carry no reliable read-only flag yet, so this is a name
 * heuristic: it errs on the side of denying (a write-looking verb anywhere in
 * the operation name wins over a read verb).
 */
export function todayAllowsTool(name: string): boolean {
  if (isTodayBriefTool(name) || isCairnReadTool(name) || ENGINE_READ_TOOLS.has(name)) return true;
  if (!isExternalToolName(name)) return false;
  // camelCase operations (Atlassian's `searchJiraIssuesUsingJql`) become snake_case words first.
  const op = operationWords(name);
  if (WRITE_VERB.test(op)) return false;
  return READ_VERB.test(op);
}

/** The toolset filter for a run: read-only, minus the apps the user turned off. */
export function todayToolFilter(settings: TodaySettings): (name: string) => boolean {
  const off = new Set(settings.excludedApps);
  return (name) => todayAllowsTool(name) && !(isExternalToolName(name) && off.has(toolServer(name)));
}

export const TODAY_RECIPE = `You are preparing the user's Today brief: one short page, read in under a minute, that says what needs them across their projects and apps. Work read-only: tools that send, post, create, edit or delete aren't available to you.

Build the brief with the brief tools as you go:
- Call today_read first. On a refresh it lists what is already there: update those items by id instead of adding copies, and remove the ones that no longer hold.
- Call today_upsert as soon as you have items (several per call). The user watches them arrive, so don't save everything for the end.
- Call today_remove for items that were handled or are no longer true.
- Call today_finish once, last, with the headline, the lede and every app you tried.

What to gather:
1. The project facts below come from Cairn's board, notes and automations. Don't search the board for them again; turn what matters into items. A card due today or overdue is a todo (id "card-<cardId>", with its projectId). A failing automation is an fyi with tone "warn". A card stuck in review can be a decision ("Merge or send it back?").
2. Use every connected app tool that can search or read (for example Slack, Outlook, Teams or Work IQ, GitHub, Jira, Confluence) for roughly the last 24 hours (72 on a Monday):
   - what waits on the user: mentions, direct messages, review requests, assigned issues, questions asked of them, things they promised;
   - today's meetings, with times (lane "event");
   - progress worth knowing that needs no action (lane "fyi").
   If an app fails or finds nothing, record that in today_finish's sources and move on.
3. For up to 4 items that need a written answer (a reply, review notes, a card breakdown), write the draft yourself (lane "draft") and link it from the decision choice it carries out with draftId. Never send anything.

How to write it:
- A "decision" is something the user has to choose: the question is yes/no or either/or, with 2 or 3 choices of 2–5 words, the one you'd recommend first. Anything else is a "todo": the action, verb first, with no choices.
- body: at most 30 words. why: one sentence on why it ranks there. facts: up to 3 chips of 2–6 words (who asked, when, what's at stake).
- Give every item an id built from where it came from, and its projectId when it clearly belongs to a project.
- Use real names, ids and numbers from tool results. Never invent anything you didn't see.
- Keep at most 6 decisions and to-dos, 5 drafts and 8 fyi items, most urgent first.
- headline: at most 10 words, verb first, naming the first decision. lede: at most 25 words of context, no counts (Cairn shows those). Don't add up free time or count meetings: Cairn works that out from the events.`;

/** The run's prompt: the fixed recipe, then today's date and Cairn's project facts. */
export function todayPrompt(facts: ReturnType<typeof projectFacts>, now: Date = new Date()): string {
  const day = now.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${TODAY_RECIPE}\n\n## Now\n${day}, ${time} local time.\n\n## Project facts (from Cairn)\n${factsForPrompt(facts)}`;
}

// ── Settings ──────────────────────────────────────────────────────────────

function settingsPath(workspacePath: string, automation: Automation): string {
  return path.join(automationFolderDir(workspacePath, automation.id, null), "today.json");
}

export function readTodaySettings(workspacePath: string, automation: Automation | null): TodaySettings {
  if (!automation) return { ...DEFAULT_TODAY_SETTINGS };
  try {
    const o = JSON.parse(fs.readFileSync(settingsPath(workspacePath, automation), "utf8")) as Partial<TodaySettings>;
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { excludedProjects: ids(o.excludedProjects), excludedApps: ids(o.excludedApps) };
  } catch {
    return { ...DEFAULT_TODAY_SETTINGS };
  }
}

export function writeTodaySettings(workspacePath: string, automation: Automation, settings: TodaySettings): void {
  const file = settingsPath(workspacePath, automation);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), "utf8");
}

/** The projects Today reads: live, not archived, not turned off in settings. */
export function includedProjects(db: Database.Database, workspaceId: string, settings: TodaySettings): Array<{ id: string; name: string }> {
  const off = new Set(settings.excludedProjects);
  return getProjects(db, workspaceId)
    .filter((p) => p.status !== "archived" && !off.has(p.id))
    .map((p) => ({ id: p.id, name: p.name }));
}

// ── Schedule ──────────────────────────────────────────────────────────────

export interface TodayEnableInput {
  workspaceId: string;
  time: string;
  weekdaysOnly: boolean;
  timezone?: string | null;
}

function nextRun(expr: string, timezone?: string | null): string {
  const next = computeNextRun(parseSchedule(expr), new Date(), timezone ?? undefined);
  if (!next) throw new Error("Schedule has no future run time.");
  return next.toISOString();
}

/**
 * Create or re-enable the workspace's Today automation with the given
 * schedule. Per-project Today rows from the preview are deleted: the
 * workspace brief replaces them.
 */
export function enableToday(db: Database.Database, input: TodayEnableInput): Automation {
  for (const a of listAutomations(db, input.workspaceId)) {
    if (isTodayAutomation(a) && a.projectId) deleteAutomation(db, a.id);
  }
  const expr = todayCron(input.time, input.weekdaysOnly);
  const existing = findTodayAutomation(db, input.workspaceId);
  if (existing) {
    return updateAutomation(db, existing.id, {
      enabled: true, scheduleKind: "cron", scheduleExpr: expr, timezone: input.timezone ?? existing.timezone,
      nextRunAt: nextRun(expr, input.timezone ?? existing.timezone), instructions: TODAY_RECIPE, approvalMode: "ask",
    })!;
  }
  return createAutomation(db, {
    workspaceId: input.workspaceId,
    projectId: null,
    name: "Today",
    description: "Built-in. Gathers your projects and connected apps into the Today view. Read-only.",
    instructions: TODAY_RECIPE,
    scheduleKind: "cron",
    scheduleExpr: expr,
    timezone: input.timezone ?? null,
    nextRunAt: nextRun(expr, input.timezone),
    enabled: true,
    approvalMode: "ask",
    source: "custom",
    communityId: TODAY_COMMUNITY_ID,
  });
}

export function disableToday(db: Database.Database, workspaceId: string): void {
  const a = findTodayAutomation(db, workspaceId);
  if (a) updateAutomation(db, a.id, { enabled: false });
}

/** Remove the row outright (tests and resets). The brief files stay on disk. */
export function deleteToday(db: Database.Database, workspaceId: string): void {
  const a = findTodayAutomation(db, workspaceId);
  if (a) deleteAutomation(db, a.id);
}

// ── Brief files ───────────────────────────────────────────────────────────

function todayDir(workspacePath: string, automation: Automation): string {
  return path.join(automationOutDir(automationFolderDir(workspacePath, automation.id, null)), "today");
}

export function saveTodayBrief(workspacePath: string, automation: Automation, brief: TodayBrief): void {
  const dir = todayDir(workspacePath, automation);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${brief.date}.json`);
  // Write then rename, so the view never reads half a file while a run is saving.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(brief, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** The most recent saved brief, newest date first. */
export function loadLatestTodayBrief(workspacePath: string, automation: Automation): TodayBrief | null {
  const dir = todayDir(workspacePath, automation);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch {
    return null;
  }
  for (let i = files.length - 1; i >= 0; i--) {
    try {
      // Re-normalise on read, so a brief saved by an older build gets today's shape.
      const text = fs.readFileSync(path.join(dir, files[i]), "utf8");
      const saved = JSON.parse(text) as { generatedAt?: unknown };
      const at = typeof saved.generatedAt === "string" ? new Date(saved.generatedAt) : null;
      const brief = parseTodayBrief(text, at && !Number.isNaN(at.getTime()) ? at : new Date());
      if (brief) return brief;
    } catch { /* try the previous day */ }
  }
  return null;
}

// ── State ─────────────────────────────────────────────────────────────────

export function getTodayState(db: Database.Database, workspacePath: string, workspaceId: string): TodayState {
  const a = findTodayAutomation(db, workspaceId);
  const fresh = a ? getAutomationById(db, a.id) ?? a : null;
  const settings = readTodaySettings(workspacePath, fresh);
  const included = includedProjects(db, workspaceId, settings);
  const projects = getProjects(db, workspaceId).filter((p) => p.status !== "archived").map((p) => ({ id: p.id, name: p.name }));
  const apps = listScopedConnectors(db, workspaceId, included.map((p) => p.id));
  const facts = projectFacts(db, workspaceId, included);
  if (!fresh) {
    return {
      automationId: null, enabled: false, time: "07:00", weekdaysOnly: true, nextRunAt: null, running: false,
      brief: null, lastError: null, settings, projects, facts, apps,
    };
  }
  const { time, weekdaysOnly } = parseTodayCron(fresh.scheduleExpr);
  const last = listAutomationRuns(db, fresh.id, 1)[0];
  const running = hasInFlightRun(db, fresh.id);
  const brief = loadLatestTodayBrief(workspacePath, fresh);
  // A run that stopped before today_finish leaves the file "gathering"; with no run going, it's as ready as it'll get.
  if (brief && brief.status === "gathering" && !running) brief.status = "ready";
  return {
    automationId: fresh.id,
    enabled: fresh.enabled,
    time,
    weekdaysOnly,
    nextRunAt: fresh.enabled ? fresh.nextRunAt : null,
    running,
    brief,
    lastError: last && (last.status === "error" || last.status === "skipped") ? last.error : null,
    settings, projects, facts, apps,
  };
}

/** What the renderer keeps locally for a brief (done/discarded ids, edited drafts), added to an export. */
export interface TodayLocalState {
  dismissed?: string[];
  edits?: Record<string, string>;
}

/**
 * Everything needed to debug a Today brief, as one JSON object: the recipe,
 * the saved brief (raw and as the app reads it), recent runs, and the latest
 * run's log and engine session events. `readSession` returns the session's
 * JSONL text for a run id, or null.
 */
export function buildTodayDebugExport(
  db: Database.Database, workspacePath: string, workspaceId: string,
  readSession: (runId: string) => string | null, local?: TodayLocalState,
): { fileName: string; data: Record<string, unknown> } {
  const a = findTodayAutomation(db, workspaceId);
  if (!a) throw new Error("Today isn't set up for this workspace.");
  const dir = todayDir(workspacePath, a);
  let savedFile: { name: string; content: unknown } | null = null;
  try {
    const name = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().pop();
    if (name) {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      let content: unknown = text;
      try { content = JSON.parse(text); } catch { /* keep the raw text */ }
      savedFile = { name, content };
    }
  } catch { /* no briefs yet */ }

  const runs = listAutomationRuns(db, a.id, 5);
  const last = runs[0];
  const sessionText = last ? readSession(last.id) : null;
  const sessionEvents = sessionText
    ? sessionText.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line) as unknown; } catch { return line; } })
    : null;
  const brief = loadLatestTodayBrief(workspacePath, a);
  const settings = readTodaySettings(workspacePath, a);
  const included = includedProjects(db, workspaceId, settings);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    fileName: `today-debug-${brief?.date ?? "none"}-${stamp}.json`,
    data: {
      kind: "cairn-today-debug/2",
      exportedAt: new Date().toISOString(),
      workspaceId,
      settings,
      projects: included,
      automation: {
        id: a.id, enabled: a.enabled, scheduleExpr: a.scheduleExpr, timezone: a.timezone,
        approvalMode: a.approvalMode, nextRunAt: a.nextRunAt,
      },
      // What runs: the current prompt, not the (possibly older) text saved on the row.
      prompt: todayPrompt(projectFacts(db, workspaceId, included)),
      brief,
      savedFile,
      local: local ?? null,
      runs: runs.map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, error: r.error, runDir: r.runDir })),
      lastRun: last ? { runLog: last.runDir ? readRunLog(last.runDir) : null, sessionEvents } : null,
    },
  };
}
