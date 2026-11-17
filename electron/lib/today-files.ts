/**
 * Today's saved files and its automation row, read and written without the rest of Today.
 *
 * Kept apart from `today.ts` (which pulls in connectors and the agent engine) so the
 * standalone `cairn-mcp` runtime can read the brief too (`get_today`). Layout, all in the
 * Today automation's folder:
 *   - `out/today/<date>.json`: the day's brief;
 *   - `out/today/<date>.marks.json`: what the user marked done and the drafts they edited;
 *   - `out/today/history/<date>@<HHMMSS>.json`: versions a same-day refresh replaced.
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Automation } from "../../shared/types/automations";
import { TODAY_COMMUNITY_ID, localDate, parseTodayBrief, type TodayBrief, type TodayHistoryEntry, type TodayMarks } from "../../shared/today/brief";
import { TODAY_KEEP_DAYS } from "../../shared/today/history";
import { listAutomations } from "../db/automation-queries";
import { automationFolderDir, automationOutDir } from "./automation-folder";

/** Briefs, marks and snapshots older than this many days are deleted when a run starts. */
export { TODAY_KEEP_DAYS };

export function isTodayAutomation(a: Pick<Automation, "communityId">): boolean {
  return a.communityId === TODAY_COMMUNITY_ID;
}

/** The workspace's Today row. */
export function findTodayAutomation(db: Database.Database, workspaceId: string): Automation | null {
  return listAutomations(db, workspaceId).find(isTodayAutomation) ?? null;
}

// ── Brief files ───────────────────────────────────────────────────────────

export function todayDir(workspacePath: string, automation: Automation): string {
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

/** A history snapshot's key after the date: `@HHMMSS`, then `-N` when it collided. */
const SNAPSHOT_KEY = /@\d{6}(?:-\d+)?/.source;
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
    // Normalised on read like the run's output: the file is on disk and may have been edited.
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
