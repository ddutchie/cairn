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
 * Files, all in the Today automation's folder:
 *   - `today.json`: the settings;
 *   - `out/today/<date>.json`: the day's brief, saved after every brief tool call;
 *   - `out/today/<date>.marks.json`: what the user marked done and the drafts they edited;
 *   - `out/today/history/<date>@<HHMMSS>.json`: the version a same-day refresh replaced (`-2`, `-3`… when
 *     two land in the same second; older builds wrote `@<HHMM>`).
 * Files older than `TODAY_KEEP_DAYS` are deleted when a run starts.
 */

import { TODAY_KEEP_DAYS } from "../../shared/today/history";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Automation } from "../../shared/types/automations";
import {
  DEFAULT_TODAY_SETTINGS, EMPTY_TODAY_MARKS, TODAY_COMMUNITY_ID, localDate, parseTodayBrief, parseTodayCron, todayCron,
  type TodayBrief, type TodayHistoryEntry, type TodayMarks, type TodaySettings, type TodayState,
} from "../../shared/today/brief";
import { isCairnReadTool, isExternalToolName } from "../../shared/agent/tool-names";
import { READ_VERB, WRITE_VERB, isWebOperation, looksLikeWebApp, operationWords, toolServer } from "../../shared/today/route";
import {
  createAutomation, deleteAutomation, getAutomationById, hasInFlightRun, listAutomationRuns, listAutomations, updateAutomation,
} from "../db/automation-queries";
import { getProjects } from "../db/workspace-queries";
import { automationFolderDir, automationOutDir, readRunLog } from "./automation-folder";
import { computeNextRun, parseSchedule } from "./automation-schedule";
import { deleteAutomationWithCleanup } from "./automation-delete";
import { listScopedConnectors } from "./external-tools";
import { factsForPrompt, projectFacts } from "./today-facts";
import { currentRunActivity } from "./run-activity";
import { isTodayBriefTool } from "./today-tools";

export function isTodayAutomation(a: Pick<Automation, "communityId">): boolean {
  return a.communityId === TODAY_COMMUNITY_ID;
}

/** The workspace's Today row. */
export function findTodayAutomation(db: Database.Database, workspaceId: string): Automation | null {
  return listAutomations(db, workspaceId).find((a) => isTodayAutomation(a) && !a.projectId) ?? null;
}

/**
 * Engine tools a Today run keeps. Local file reads (`read`, `grep`, `glob`) and `web_fetch` are left
 * out: the run reads untrusted messages, and with both it could be talked into reading a file and
 * fetching a URL that carries its contents away, with nobody there to approve. Cairn's own facts
 * come in the prompt, so the brief doesn't need them.
 */
const ENGINE_READ_TOOLS = new Set([
  "skill", "todo_write",
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
  // Web search tools are the user's choice (see todayToolFilter), never offered by default.
  if (WRITE_VERB.test(op) || isWebOperation(op)) return false;
  return READ_VERB.test(op);
}

/**
 * The toolset filter for a run: read-only, minus the apps the user turned off. A web search tool is
 * left out unless the user turned its app on in Today's settings (`webApps`): a search can carry what
 * the run read in their other apps to that service, so it's their choice, and off until they make it.
 */
export function todayToolFilter(
  settings: TodaySettings,
  connectors: { webServers: ReadonlySet<string>; writeTools: ReadonlySet<string> } = { webServers: new Set(), writeTools: new Set() },
): (name: string) => boolean {
  const off = new Set(settings.excludedApps);
  const webOn = new Set(settings.webApps);
  return (name) => {
    if (!isExternalToolName(name)) return todayAllowsTool(name);
    const server = toolServer(name);
    // An app that's off, and a custom service operation that doesn't use GET, are never offered.
    if (off.has(server) || connectors.writeTools.has(name)) return false;
    const op = operationWords(name);
    // A web search app needs the user's say-so for every tool, not only the ones with "web" in the name.
    if (isWebOperation(op) || connectors.webServers.has(server)) {
      if (!webOn.has(server) || WRITE_VERB.test(op)) return false;
      return isWebOperation(op) || READ_VERB.test(op);
    }
    return todayAllowsTool(name);
  };
}

/** Today cuts each connector result to this many characters: a brief needs the gist, and a 90K-character search fills the context. */
/**
 * Today's reasoning effort: low, whatever chat uses (off stays off). The brief is a sort-and-draft job; on
 * high, a model spends most of the run planning in its thinking and writing each item twice. Sent
 * explicitly, since with no effort a reasoning model uses its own default, which can be high.
 */
export function todayReasoningEffort(chat: string | undefined): "off" | "low" {
  return chat === "off" ? "off" : "low";
}

export const TODAY_RESULT_CHARS = 16_000;

/**
 * Today's own system prompt. Runs used to get the chat assistant's, which tells the model to call
 * get_context first, write without asking and reply in markdown: wrong for an unattended, read-only
 * run. Fixed text, so the provider can cache it; everything that changes per run is in the prompt.
 */
export const TODAY_SYSTEM_PROMPT = `You are Cairn's Today brief builder. You run unattended, usually before the user starts work, so there's nobody to ask: decide for yourself and keep going.

You can only read. Tools that send, post, create, edit or delete aren't available, so don't look for them and never try to send anything. You write the brief only through the today_* tools. After today_finish, end with a short note for the user, at most 5 bullets: what you changed and what failed or was missing. Cairn shows it as the run's notes. Keep anything else you write to a sentence.

Use only what tool results and the project facts say. Never invent a name, time, id or number. When something can't be found, say so in today_finish's sources rather than guessing.`;

export const TODAY_RECIPE = `Prepare the user's Today brief: one short page, read in under a minute, that says what needs them across their projects and apps. The sections below say what to gather; "Now" at the end gives the date, the time zone and the exact time to look back to.

## How to build it
- Call today_read first. On a refresh it lists what is already there: update those items by id instead of adding copies, and remove the ones that no longer hold.
- Then make all your searches in one round, in parallel: the calendar, messages, mail and work tracking, each as its own call (a calendar question and a mail question to the same app are two calls in that round). Follow up only where a result needs it.
- Call today_upsert as soon as you have items (several per call). The user watches them arrive, so don't save everything for the end.
- Call today_remove for items that were handled or are no longer true.
- Call today_finish once, last, with the headline, the lede and a source for each area below.
- Keep your thinking short: decide, then put the item text straight into today_upsert. Don't plan every call or re-read these instructions.

## Calendar
- Read the user's whole calendar for today on every run, whatever the last brief covered. The calendar is a picture of the day, not a list of changes.
- Only meetings on today's date (see "Now") are events, even late in the day: never add tomorrow's.
- Use whichever connected tool can read the calendar: a calendar or events tool if there is one, or an assistant-style tool you can ask about the user's schedule. Ask about today's meetings in a call of its own, not combined with mail or messages, and ask for start and end times.
- Add each meeting as an "event" with title, its date (today's, from "Now"), start and end as local 24-hour HH:MM (10:35 AM is "10:35", 1 PM is "13:00"), and location when given. Leave out declined and cancelled meetings and all-day entries. On a refresh, update events by id and remove the ones that are gone.
- Use note only for a clash or something to prepare. Don't add up free time or count meetings: Cairn works that out from the events.
- If no connected tool can read a calendar, add no events and record the calendar source as "error" with the note "no calendar app connected". If a tool answers that it can't reach the calendar right now, ask once more with a shorter question; if it still can't, record that.

## Communication
- Search messages and mail since the look-back time in "Now": chat apps (Slack, Teams and the like), email, and assistant-style tools that can search them.
- Look for what waits on the user: mentions, direct messages, questions asked of them, requests, and things they promised.
- Keep each call narrow: to the user (mentions, DMs, their inbox), since the look-back time, at most 20 results. Don't list every channel. When a tool takes a Unix timestamp, use the one in "Now"; don't work one out yourself.
- Search each chat or mail app twice, in the same first round, as separate calls:
  - what's new: mentions, direct messages and mail to the user since the look-back time;
  - what's still open: questions and requests to the user since the "Still open since" time in "Now", so you can spot the ones they haven't answered. Use whatever filter the tool has (unread, unanswered, waiting on me); if it has none, search the 7 days and judge from the replies in the results.
  Add the open ones that still need the user. Items already in the brief cover what earlier runs found: update those rather than adding copies.

## Work tracking
- Search issue trackers and code hosts (Jira, GitHub, Linear and the like) twice, in the same round:
  - what's new: comments, mentions and status changes on the user's items since the look-back time;
  - what's open, with no date filter: issues assigned to the user that aren't done and reviews waiting on them, highest priority or oldest first, at most 10. Add the ones that are overdue, blocked or due soon; leave the rest out.
- Results over 16,000 characters are cut: narrow the call rather than paging through.

## Projects (from Cairn)
- The project facts at the end come from Cairn's boards, notes and automations. Don't search the board for them again; turn what matters into items.
- A card due today or overdue is a todo (id "card-<cardId>", with its projectId). A card stuck in review can be a decision ("Merge or send it back?"). A failing automation is an fyi with tone "warn".
- Call get_item only for cards you will turn into an item; the facts already have their titles and dates.

## Carried items
Items with "carriedSince" are still open from an earlier day. Don't look each one up: the searches above show what changed. Remove one if those results or the project facts show it was handled (answered, merged, closed, moved on), update it if something changed, and otherwise leave it as it is. Don't add a second copy.

## Drafts
For up to 4 items that need a written answer (a reply, review notes, a card breakdown), write the draft yourself (lane "draft") and link it from the decision choice it carries out with draftId.

## How to write items
- A "decision" is something the user has to choose: the question is yes/no or either/or, with 2 or 3 choices of 2–5 words, the one you'd recommend first. Anything else is a "todo": the action, verb first, with no choices.
- body: at most 30 words. why: one sentence on why it ranks there. facts: up to 3 chips of 2–6 words (who asked, when, what's at stake).
- Give every item an id built from where it came from, and its projectId when it clearly belongs to a project.
- Progress worth knowing that needs no action is "fyi".
- Give every decision and to-do a priority: "high" (due today, overdue, or someone is waiting on the user), "normal", or "low" (can wait this week). Add every open item that needs the user, most urgent first: the brief shows the high ones first and folds the rest. Up to 15 decisions and to-dos, 8 drafts and 10 fyi items.
- today_remove is only for items that were handled or are no longer true, with the reason. Never remove an open item to make room for a new one.
- headline: at most 10 words, verb first, naming the first decision. lede: at most 25 words of context, no counts (Cairn shows those).
- sources in today_finish: one entry for the calendar, then one for each app you searched, with "ok", "empty" or "error" and a short note.`;

/**
 * Where a run's "since the last brief" starts: when the last run that finished properly started.
 * A failed or cut-off run still saves a brief, but it may not have reached every app, so its time
 * would hide what it missed. Null when no run has finished yet (the prompt then looks back 24–72 hours).
 */
export function todayLookBackFrom(db: Database.Database, automationId: string, excludeRunId?: string): string | null {
  return listAutomationRuns(db, automationId, 50).find((r) => r.id !== excludeRunId && r.status === "done")?.startedAt ?? null;
}

// Workspaces whose next Today run is a rebuild (set by "Rebuild", taken by the run it starts).
const pendingRebuilds = new Set<string>();

/** Marks the next Today run of this automation as a rebuild. */
export function requestTodayRebuild(automationId: string): void { pendingRebuilds.add(automationId); }

/** True once for the run after `requestTodayRebuild`; false for every other run. */
export function takeTodayRebuild(automationId: string): boolean { return pendingRebuilds.delete(automationId); }

/**
 * The run's prompt: the fixed recipe, then the date, when the last brief ran, and Cairn's project facts.
 * A rebuild ignores when the last brief ran and looks back the full window, so what earlier runs missed
 * is found again; the items already in the brief stay and are checked like any other.
 */
export function todayPrompt(facts: ReturnType<typeof projectFacts>, lastBriefAt: string | null, now: Date = new Date(), rebuild = false): string {
  const when = (d: Date) => `${d.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  const last = lastBriefAt ? new Date(lastBriefAt) : null;
  const fromLast = !rebuild && last !== null && !Number.isNaN(last.getTime());
  // Cairn works the look-back time out, in every form a tool may want: a model's own Unix time can be
  // a year out (a Slack search once started from the year before).
  const since = fromLast && last ? last : new Date(now.getTime() - (now.getDay() === 1 ? 72 : 24) * HOUR_MS);
  const week = new Date(now.getTime() - 7 * 24 * HOUR_MS);
  const why = rebuild
    ? "The user asked for a rebuild: look back the full window, as if there were no earlier brief. Items already in the brief stay unless what you find shows they were handled."
    : fromLast ? "That's when the last brief ran: look for what changed since then." : "There's no earlier brief, so this looks back 24 hours (72 on a Monday).";
  return `${TODAY_RECIPE}

## Now
- Today: ${when(now)} local time (${timeZoneLabel(now)}). Today's date is ${localDate(now)}.
- Look back to: ${when(since)} local time, ${isoWithOffset(since)}, Unix ${Math.floor(since.getTime() / 1000)}. ${why}
- Still open since (7 days back): ${when(week)} local time, ${isoWithOffset(week)}, Unix ${Math.floor(week.getTime() / 1000)}.

## Project facts (from Cairn)
${factsForPrompt(facts)}`;
}

const HOUR_MS = 3_600_000;

/** "Europe/London, UTC+00:00": the zone name when the runtime knows it, and the offset. */
function timeZoneLabel(d: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [zone, `UTC${utcOffset(d)}`].filter(Boolean).join(", ");
}

function utcOffset(d: Date): string {
  const m = -d.getTimezoneOffset();
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${m < 0 ? "-" : "+"}${pad(m / 60)}:${pad(m % 60)}`;
}

/** Local time as ISO 8601 with its offset, e.g. 2026-11-16T20:33:00-05:00. */
function isoWithOffset(d: Date): string {
  const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;
  return `${localDate(d)}T${t}${utcOffset(d)}`;
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
    return { excludedProjects: ids(o.excludedProjects), excludedApps: ids(o.excludedApps), webApps: ids(o.webApps) };
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

/** Create or re-enable the workspace's Today automation with the given schedule. */
export function enableToday(db: Database.Database, workspacePath: string, input: TodayEnableInput): Automation {
  migrateLegacyToday(db, workspacePath, input.workspaceId);
  return upsertTodayRow(db, input);
}

/**
 * The preview made one Today row per project. Fold them into the workspace
 * row: it takes the schedule of the first enabled one (and is on when any
 * was), then the old rows are deleted with their folders. Their briefs were
 * per project, so they aren't kept. Safe to call on every read.
 */
export function migrateLegacyToday(db: Database.Database, workspacePath: string, workspaceId: string): void {
  const legacy = listAutomations(db, workspaceId).filter((a) => isTodayAutomation(a) && a.projectId);
  if (legacy.length === 0) return;
  if (!findTodayAutomation(db, workspaceId)) {
    const src = legacy.find((a) => a.enabled) ?? legacy[0];
    const { time, weekdaysOnly } = parseTodayCron(src.scheduleExpr);
    const row = upsertTodayRow(db, { workspaceId, time, weekdaysOnly, timezone: src.timezone });
    if (!legacy.some((a) => a.enabled)) updateAutomation(db, row.id, { enabled: false });
  }
  // Today rows hold no secrets; a folder that can't be removed keeps its row, and the next read retries.
  for (const a of legacy) deleteAutomationWithCleanup(db, workspacePath, a.id, { purgeSecrets: () => {} });
}

function upsertTodayRow(db: Database.Database, input: TodayEnableInput): Automation {
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

/** Briefs, marks and snapshots older than this many days are deleted when a run starts. */
export { TODAY_KEEP_DAYS };

function historyDir(workspacePath: string, automation: Automation): string {
  return path.join(todayDir(workspacePath, automation), "history");
}

function marksPath(workspacePath: string, automation: Automation, date: string): string {
  return path.join(todayDir(workspacePath, automation), `${date}.marks.json`);
}

export function readTodayMarks(workspacePath: string, automation: Automation, date: string): TodayMarks {
  try {
    const o = JSON.parse(fs.readFileSync(marksPath(workspacePath, automation, date), "utf8")) as Partial<TodayMarks>;
    const done = Array.isArray(o.done) ? o.done.filter((x): x is string => typeof x === "string") : [];
    const edits: Record<string, string> = {};
    if (o.edits && typeof o.edits === "object") for (const [k, v] of Object.entries(o.edits)) if (typeof v === "string") edits[k] = v;
    return { done, edits };
  } catch {
    return { done: [], edits: {} };
  }
}

/** Mark items done (true) or not (false), and set (text) or drop (null) draft edits, for one day. */
export function updateTodayMarks(
  workspacePath: string, automation: Automation, date: string,
  patch: { done?: Record<string, boolean>; edits?: Record<string, string | null> },
): TodayMarks {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid date.");
  const marks = readTodayMarks(workspacePath, automation, date);
  const done = new Set(marks.done);
  for (const [id, on] of Object.entries(patch.done ?? {})) { if (on) done.add(id); else done.delete(id); }
  const edits = { ...marks.edits };
  for (const [id, text] of Object.entries(patch.edits ?? {})) { if (text === null) delete edits[id]; else edits[id] = text; }
  const next = { done: [...done], edits };
  const file = marksPath(workspacePath, automation, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A history snapshot's key after the date: `@HHMM` (older builds) or `@HHMMSS`, then `-N` when it collided. */
const SNAPSHOT_KEY = /@\d{4}(?:\d{2})?(?:-\d+)?/.source;
const DATE_KEY = /\d{4}-\d{2}-\d{2}/.source;

/** Keep the version a same-day refresh is about to replace, as `history/<date>@<HHMMSS>.json`. Never overwrites one. */
export function snapshotTodayBrief(workspacePath: string, automation: Automation, brief: TodayBrief): void {
  const at = new Date(brief.generatedAt);
  const stamp = Number.isNaN(at.getTime()) ? "000000" : `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const dir = historyDir(workspacePath, automation);
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n++) {
    const file = path.join(dir, `${brief.date}@${stamp}${n > 1 ? `-${n}` : ""}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify(brief, null, 2), { encoding: "utf8", flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n >= 100) throw err;
    }
  }
}

/** Delete briefs, marks and snapshots from before the last `keepDays` days. Returns how many files went. */
export function pruneTodayFiles(workspacePath: string, automation: Automation, now: Date = new Date(), keepDays = TODAY_KEEP_DAYS): number {
  const cutoff = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays));
  let removed = 0;
  for (const dir of [todayDir(workspacePath, automation), historyDir(workspacePath, automation)]) {
    let files: string[];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})[.@]/);
      if (!m || m[1] >= cutoff) continue;
      try { fs.rmSync(path.join(dir, f), { force: true }); removed++; } catch { /* retried next run */ }
    }
  }
  return removed;
}

function readBriefFile(file: string): TodayBrief | null {
  try {
    const text = fs.readFileSync(file, "utf8");
    const saved = JSON.parse(text) as { generatedAt?: unknown };
    const at = typeof saved.generatedAt === "string" ? new Date(saved.generatedAt) : null;
    // Re-normalise on read, so a brief saved by an older build gets today's shape.
    return parseTodayBrief(text, at && !Number.isNaN(at.getTime()) ? at : new Date());
  } catch {
    return null;
  }
}

/** Every saved version, newest first: each day's brief and the versions refreshes replaced. */
export function listTodayHistory(workspacePath: string, automation: Automation): TodayHistoryEntry[] {
  const files: Array<{ key: string; file: string }> = [];
  const add = (dir: string, re: RegExp) => {
    try {
      for (const f of fs.readdirSync(dir)) if (re.test(f)) files.push({ key: f.replace(/\.json$/, ""), file: path.join(dir, f) });
    } catch { /* none yet */ }
  };
  add(todayDir(workspacePath, automation), /^\d{4}-\d{2}-\d{2}\.json$/);
  add(historyDir(workspacePath, automation), new RegExp(`^${DATE_KEY}${SNAPSHOT_KEY}[.]json$`));
  return files.flatMap(({ key, file }) => {
    const b = readBriefFile(file);
    if (!b) return [];
    const carried = b.needYou.filter((n) => n.since).length;
    return [{
      key, date: b.date, generatedAt: b.generatedAt, headline: b.headline,
      counts: { need: b.needYou.length, prepared: b.prepared.length, fyi: b.fyi.length, events: b.events.length, carried },
    }];
  }).sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
}

/** One saved version by its history key, with that day's marks. */
export function loadTodaySnapshot(workspacePath: string, automation: Automation, key: string): { brief: TodayBrief; marks: TodayMarks } | null {
  const m = key.match(new RegExp(`^(${DATE_KEY})(${SNAPSHOT_KEY})?$`));
  if (!m) return null;
  const file = m[2] ? path.join(historyDir(workspacePath, automation), `${key}.json`) : path.join(todayDir(workspacePath, automation), `${key}.json`);
  const brief = readBriefFile(file);
  return brief ? { brief, marks: readTodayMarks(workspacePath, automation, m[1]) } : null;
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
    const brief = readBriefFile(path.join(dir, files[i]));
    if (brief) return brief;
  }
  return null;
}

// ── State ─────────────────────────────────────────────────────────────────

export function getTodayState(db: Database.Database, workspacePath: string, workspaceId: string): TodayState {
  migrateLegacyToday(db, workspacePath, workspaceId);
  const a = findTodayAutomation(db, workspaceId);
  const fresh = a ? getAutomationById(db, a.id) ?? a : null;
  const settings = readTodaySettings(workspacePath, fresh);
  const included = includedProjects(db, workspaceId, settings);
  const projects = getProjects(db, workspaceId).filter((p) => p.status !== "archived").map((p) => ({ id: p.id, name: p.name }));
  const apps = listScopedConnectors(db, workspaceId, included.map((p) => p.id)).map((a) => (looksLikeWebApp(a.name) ? { ...a, web: true } : a));
  const facts = projectFacts(db, workspaceId, included);
  if (!fresh) {
    return {
      automationId: null, enabled: false, time: "07:00", weekdaysOnly: true, nextRunAt: null, running: false, activity: null,
      brief: null, marks: { ...EMPTY_TODAY_MARKS }, lastError: null, settings, projects, facts, apps,
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
    activity: running ? currentRunActivity(fresh.id) : null,
    brief,
    marks: brief ? readTodayMarks(workspacePath, fresh, brief.date) : { ...EMPTY_TODAY_MARKS },
    lastError: last && (last.status === "error" || last.status === "skipped") ? last.error : null,
    settings, projects, facts, apps,
  };
}

/**
 * Everything needed to debug a Today brief, as one JSON object: the recipe,
 * the saved brief (raw and as the app reads it), recent runs, and the latest
 * run's log and engine session events. `readSession` returns the session's
 * JSONL text for a run id, or null.
 */
/** One model step of a run, for the debug export: how long it took and where its output went. */
export interface TodayRunStep {
  step: number;
  /** Seconds from the prompt or the last tool result to this reply. */
  seconds: number | null;
  input?: number;
  output?: number;
  cacheRead?: number;
  thinkingChars: number;
  textChars: number;
  calls: string[];
  stopReason?: string;
}

/** Per-step timing and token use from a run's session events (`{ time, event }` lines). */
export function summariseRunSteps(events: readonly unknown[]): { steps: TodayRunStep[]; totals: Record<string, number> } {
  const steps: TodayRunStep[] = [];
  let since: number | null = null;
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const { time, event } = raw as { time?: number; event?: { type?: string; message?: Record<string, unknown> } };
    if (!event) continue;
    if (event.type === "user/message" || event.type === "tool/result") { if (typeof time === "number") since = time; continue; }
    if (event.type !== "assistant/message" || !event.message) continue;
    const m = event.message as { content?: Array<Record<string, unknown>>; usage?: Record<string, number>; stopReason?: string };
    const blocks = Array.isArray(m.content) ? m.content : [];
    const chars = (type: string, key: string) => blocks.filter((b) => b.type === type).reduce((n, b) => n + String(b[key] ?? "").length, 0);
    steps.push({
      step: steps.length + 1,
      seconds: typeof time === "number" && since !== null ? Math.round((time - since) / 100) / 10 : null,
      input: m.usage?.input, output: m.usage?.output, cacheRead: m.usage?.cacheRead,
      thinkingChars: chars("thinking", "thinking"),
      textChars: chars("text", "text"),
      calls: blocks.filter((b) => b.type === "toolCall").map((b) => String(b.name ?? "")),
      stopReason: m.stopReason,
    });
  }
  const sum = (f: (s: TodayRunStep) => number | null | undefined) => Math.round(steps.reduce((n, s) => n + (f(s) ?? 0), 0) * 10) / 10;
  return {
    steps,
    totals: {
      steps: steps.length, modelSeconds: sum((s) => s.seconds), outputTokens: sum((s) => s.output),
      thinkingChars: sum((s) => s.thinkingChars), toolCalls: sum((s) => s.calls.length),
    },
  };
}

export function buildTodayDebugExport(
  db: Database.Database, workspacePath: string, workspaceId: string,
  readSession: (runId: string) => string | null,
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
  const runLog = last?.runDir ? readRunLog(last.runDir) : null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    fileName: `today-debug-${brief?.date ?? "none"}-${stamp}.json`,
    data: {
      kind: "cairn-today-debug/3",
      exportedAt: new Date().toISOString(),
      workspaceId,
      settings,
      projects: included,
      automation: {
        id: a.id, enabled: a.enabled, scheduleExpr: a.scheduleExpr, timezone: a.timezone,
        approvalMode: a.approvalMode, nextRunAt: a.nextRunAt,
      },
      // The last run as it was sent: model settings, system prompt, tools and prompt, then how each step went.
      lastRunSetup: runLog?.setup ?? null,
      lastRunPrompt: runLog?.recipe ?? null,
      lastRunSteps: sessionEvents ? summariseRunSteps(sessionEvents) : null,
      // What the next run would be sent, built now.
      nextSystemPrompt: TODAY_SYSTEM_PROMPT,
      nextPrompt: todayPrompt(projectFacts(db, workspaceId, included), todayLookBackFrom(db, a.id)),
      brief,
      marks: brief ? readTodayMarks(workspacePath, a, brief.date) : null,
      history: listTodayHistory(workspacePath, a),
      savedFile,
      runs: runs.map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, error: r.error, runDir: r.runDir })),
      lastRun: last ? { runLog, sessionEvents } : null,
    },
  };
}
