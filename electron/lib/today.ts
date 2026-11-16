/**
 * Today: the built-in automation behind Overview → Today.
 *
 * One automation row per project, marked with `communityId = TODAY_COMMUNITY_ID`.
 * It runs through the normal heartbeat runner (schedule, connectors, run log,
 * run history), with two differences applied there:
 *   - a read-only gate: Cairn read tools and read-like connector tools run,
 *     every other call is denied instead of asked (an unattended 07:00 run
 *     never waits on the user and never changes anything);
 *   - the final message is parsed into a `TodayBrief` and saved under the
 *     automation's durable `out/today/` folder.
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Automation } from "../../shared/types/automations";
import {
  TODAY_COMMUNITY_ID, parseTodayBrief, parseTodayCron, todayCron,
  type TodayBrief, type TodayState,
} from "../../shared/today/brief";
import { isCairnReadTool, isExternalToolName } from "../../shared/agent/tool-names";
import { READ_VERB, WRITE_VERB, operationWords } from "../../shared/today/route";
import {
  createAutomation, deleteAutomation, getAutomationById, hasInFlightRun, listAutomationRuns, listAutomations, updateAutomation,
} from "../db/automation-queries";
import { automationFolderDir, automationOutDir, readRunLog } from "./automation-folder";
import { computeNextRun, parseSchedule } from "./automation-schedule";

export function isTodayAutomation(a: Pick<Automation, "communityId">): boolean {
  return a.communityId === TODAY_COMMUNITY_ID;
}

export function findTodayAutomation(db: Database.Database, workspaceId: string, projectId: string): Automation | null {
  return listAutomations(db, workspaceId).find((a) => isTodayAutomation(a) && a.projectId === projectId) ?? null;
}

/** Engine tools that only read (files in the run folder, the web). */
const ENGINE_READ_TOOLS = new Set([
  "read", "read_image", "grep", "glob", "web_fetch", "skill", "todo_write", "codebase_query",
  "read_mcp_resource", "list_mcp_resources", "list_mcp_resource_templates",
]);

/**
 * Today's read-only policy. Built-in reads pass; a connector tool passes when
 * its operation name reads like a read (`mcp__slack__search_messages`,
 * `mcp__workiq__ask`). Everything else is denied.
 *
 * Connector tools carry no reliable read-only flag yet, so this is a name
 * heuristic: it errs on the side of denying (a write-looking verb anywhere in
 * the operation name wins over a read verb).
 */
export function todayAllowsTool(name: string): boolean {
  if (isCairnReadTool(name) || ENGINE_READ_TOOLS.has(name)) return true;
  if (!isExternalToolName(name)) return false;
  // camelCase operations (Atlassian's `searchJiraIssuesUsingJql`) become snake_case words first.
  const op = operationWords(name);
  if (WRITE_VERB.test(op)) return false;
  return READ_VERB.test(op);
}

export const TODAY_RECIPE = `You are preparing the user's "Today" brief for this project. Work read-only: you may only use tools that look things up. Any tool that sends, posts, creates, edits or deletes will be refused, so don't try.

1. Look at this project in Cairn: the board (cards in progress, in review, due or overdue, stale for 5+ days), recently changed notes, and recent automation runs.
2. Use every connected connector tool that can search or read (for example Slack, Microsoft Work IQ / Outlook / Teams, GitHub, Atlassian) to find, for roughly the last 24 hours (72 on a Monday):
   - things waiting on the user: mentions, direct messages, review requests, assigned issues, questions asked of them, things they promised to do;
   - today's meetings, with times;
   - notable progress that needs no action.
   If a connector fails or returns nothing, note it in "sources" and move on.
3. For up to 4 items that need a written answer (a reply, review notes, a card breakdown), write the draft yourself. Never send it.
4. Keep it short and specific. Use real names, ids and numbers from what you found. Never invent anything you did not see in a tool result.

Write it as a brief someone reads in under a minute and acts on:
- "headline": at most 10 words, starts with a verb, names the first decision ("Decide on Edan's P4 interview first.").
- "lede": at most 25 words, one or two sentences of context. No counts: Cairn shows those.
- A needYou item is a "decision" when the user has to choose; phrase its "question" as a yes/no or either/or question and give 2 or 3 short "choices" (2–5 words each, the one you'd recommend first). Otherwise it is a "todo": phrase the "question" as the action to take, with no choices.
- "body": at most 30 words. "why": one sentence on why it ranks where it does. "facts": up to 3 chips of 2–6 words (who asked, when, what's at stake). Start a fact with "⚠ " only for a real problem, such as a mismatch or a clash.
- A draft that carries out a choice is linked from that choice's "draftId". Don't also put it in the item's "draftId".
- Don't add up free time or count meetings: Cairn works that out from "events".

Finish with ONLY this JSON object in a \`\`\`json fence, nothing after it:
{
  "headline": "Verb-first line naming the first decision",
  "lede": "One or two sentences of context",
  "focusId": "id of the single needYou item to start with",
  "events": [{ "title": "", "start": "HH:MM", "end": "HH:MM", "location": "", "url": "", "note": "only for a clash or something to prepare" }],
  "needYou": [{ "id": "n1", "kind": "decision|todo", "question": "", "body": "", "why": "", "facts": ["Asked 12:56"], "choices": [{ "label": "Yes, approve", "draftId": "d1" }, { "label": "Hold" }], "source": "Slack", "url": "", "age": "3d" }],
  "prepared": [{ "id": "d1", "title": "", "kind": "reply|review|cards|note|other", "target": "where it would go", "draft": "the full drafted text", "source": "", "url": "" }],
  "fyi": [{ "title": "", "detail": "", "tone": "good|warn|neutral", "source": "", "url": "" }],
  "sources": [{ "name": "Slack", "status": "ok|empty|error|skipped", "items": 0, "note": "" }],
  "gap": "optional: one sentence on a missing connector that would have helped"
}
Use at most 5 needYou, 4 prepared and 6 fyi items. Use local 24-hour times. Leave out fields you have nothing for.`;

export interface TodayEnableInput {
  workspaceId: string;
  projectId: string;
  time: string;
  weekdaysOnly: boolean;
  timezone?: string | null;
}

function nextRun(expr: string, timezone?: string | null): string {
  const next = computeNextRun(parseSchedule(expr), new Date(), timezone ?? undefined);
  if (!next) throw new Error("Schedule has no future run time.");
  return next.toISOString();
}

/** Create or re-enable the project's Today automation with the given schedule. */
export function enableToday(db: Database.Database, input: TodayEnableInput): Automation {
  const expr = todayCron(input.time, input.weekdaysOnly);
  const existing = findTodayAutomation(db, input.workspaceId, input.projectId);
  if (existing) {
    return updateAutomation(db, existing.id, {
      enabled: true, scheduleKind: "cron", scheduleExpr: expr, timezone: input.timezone ?? existing.timezone,
      nextRunAt: nextRun(expr, input.timezone ?? existing.timezone), instructions: TODAY_RECIPE, approvalMode: "ask",
    })!;
  }
  return createAutomation(db, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    name: "Today",
    description: "Built-in. Gathers this project's board and your connected apps into Overview → Today. Read-only.",
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

export function disableToday(db: Database.Database, workspaceId: string, projectId: string): void {
  const a = findTodayAutomation(db, workspaceId, projectId);
  if (a) updateAutomation(db, a.id, { enabled: false });
}

/** Remove the row outright (tests and resets). The brief files stay on disk. */
export function deleteToday(db: Database.Database, workspaceId: string, projectId: string): void {
  const a = findTodayAutomation(db, workspaceId, projectId);
  if (a) deleteAutomation(db, a.id);
}

function todayDir(workspacePath: string, automation: Automation, projectName: string | null): string {
  return path.join(automationOutDir(automationFolderDir(workspacePath, automation.id, projectName)), "today");
}

/** Parse the run's final message and save it. Returns the brief, or null when the message held none. */
export function saveTodayBrief(
  workspacePath: string, automation: Automation, projectName: string | null, finalMessage: string,
): TodayBrief | null {
  const brief = parseTodayBrief(finalMessage);
  if (!brief) return null;
  const dir = todayDir(workspacePath, automation, projectName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${brief.date}.json`), JSON.stringify(brief, null, 2), "utf8");
  return brief;
}

/** The most recent saved brief, newest date first. */
export function loadLatestTodayBrief(workspacePath: string, automation: Automation, projectName: string | null): TodayBrief | null {
  const dir = todayDir(workspacePath, automation, projectName);
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

export function getTodayState(
  db: Database.Database, workspacePath: string, workspaceId: string, projectId: string, projectName: string | null,
): TodayState {
  const a = findTodayAutomation(db, workspaceId, projectId);
  if (!a) {
    return { automationId: null, enabled: false, time: "07:00", weekdaysOnly: true, nextRunAt: null, running: false, brief: null, lastError: null };
  }
  const fresh = getAutomationById(db, a.id) ?? a;
  const { time, weekdaysOnly } = parseTodayCron(fresh.scheduleExpr);
  const last = listAutomationRuns(db, fresh.id, 1)[0];
  return {
    automationId: fresh.id,
    enabled: fresh.enabled,
    time,
    weekdaysOnly,
    nextRunAt: fresh.enabled ? fresh.nextRunAt : null,
    running: hasInFlightRun(db, fresh.id),
    brief: loadLatestTodayBrief(workspacePath, fresh, projectName),
    lastError: last && (last.status === "error" || last.status === "skipped") ? last.error : null,
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
  db: Database.Database, workspacePath: string, workspaceId: string, projectId: string, projectName: string | null,
  readSession: (runId: string) => string | null, local?: TodayLocalState,
): { fileName: string; data: Record<string, unknown> } {
  const a = findTodayAutomation(db, workspaceId, projectId);
  if (!a) throw new Error("Today isn't set up for this project.");
  const dir = todayDir(workspacePath, a, projectName);
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
  const brief = loadLatestTodayBrief(workspacePath, a, projectName);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    fileName: `today-debug-${brief?.date ?? "none"}-${stamp}.json`,
    data: {
      kind: "cairn-today-debug/1",
      exportedAt: new Date().toISOString(),
      project: { id: projectId, name: projectName },
      automation: {
        id: a.id, enabled: a.enabled, scheduleExpr: a.scheduleExpr, timezone: a.timezone,
        approvalMode: a.approvalMode, nextRunAt: a.nextRunAt,
      },
      // What runs: the current recipe, not the (possibly older) text saved on the row.
      recipe: TODAY_RECIPE,
      brief,
      savedFile,
      local: local ?? null,
      runs: runs.map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, error: r.error, runDir: r.runDir })),
      lastRun: last ? { runLog: last.runDir ? readRunLog(last.runDir) : null, sessionEvents } : null,
    },
  };
}
