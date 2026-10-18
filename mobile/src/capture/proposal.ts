import { pickProject } from "./rank";
import {
  COLUMN_TYPES,
  PRIORITIES,
  type CaptureContext,
  type CaptureProject,
  type CaptureProposal,
  type CaptureTaskDraft,
  type ColumnType,
  type Priority,
} from "./types";

const MAX_TASKS = 8;
const MAX_TAGS = 5;
const MAX_LINKS = 5;
const TITLE_MAX = 60;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A short note/task title from raw text: first meaningful line, markdown stripped, ≤60 chars. */
export function deriveTitle(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s+)/, "").trim())
      .find((l) => l.length > 0) ?? "";
  if (!line) return "Quick capture";
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Column id for a project: the one of `type`, else the first column. */
export function columnIdFor(project: CaptureProject, type?: string): string | null {
  return (type ? project.columns.find((c) => c.type === type)?.id : undefined) ?? project.columns[0]?.id ?? null;
}

/** YYYY-MM-DD that is a real calendar date on or after `today`, else undefined. */
function validDueDate(v: unknown, today: string): string | undefined {
  const s = str(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return undefined;
  return s >= today ? s : undefined;
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of v) {
    const name = str(raw).replace(/^#+/, "").trim();
    if (!name || name.length > 32) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function cleanTasks(v: unknown, today: string): CaptureTaskDraft[] {
  if (!Array.isArray(v)) return [];
  const out: CaptureTaskDraft[] = [];
  for (const raw of v) {
    if (!isObj(raw)) continue;
    const title = str(raw.title).slice(0, 200);
    if (!title) continue;
    const task: CaptureTaskDraft = { title };
    const description = str(raw.description);
    if (description) task.description = description;
    const priority = str(raw.priority);
    if ((PRIORITIES as readonly string[]).includes(priority)) task.priority = priority as Priority;
    const columnType = str(raw.columnType);
    if ((COLUMN_TYPES as readonly string[]).includes(columnType)) task.columnType = columnType as ColumnType;
    const dueDate = validDueDate(raw.dueDate, today);
    if (dueDate) task.dueDate = dueDate;
    out.push(task);
    if (out.length >= MAX_TASKS) break;
  }
  return out;
}

/** Plain note in the best-ranked (or most recent) project: the safe answer when AI is unavailable. */
export function fallbackProposal(text: string, ctx: CaptureContext): CaptureProposal | null {
  const picked = pickProject(ctx);
  if (!picked) return null;
  return {
    projectId: picked.projectId,
    note: { title: deriveTitle(text), body: text.trim() },
    tasks: [],
    tagNames: [],
    linkNoteIds: [],
    reason: picked.confident ? "Closest match to your existing notes" : "Saved as a note — pick a project if this isn't right",
    source: "fallback",
  };
}

/**
 * Validate the model's `file_capture` arguments against reality. Unknown projects
 * fall back to the ranked pick; unknown note ids, past due dates, oversized or
 * duplicate tags and empty tasks are dropped; `[[wikilinks]]` are only ever built
 * from the exact titles of real candidate notes. Returns null only when there is
 * no project to file into.
 */
export function normalizeProposal(raw: unknown, ctx: CaptureContext, text: string): CaptureProposal | null {
  const fallback = fallbackProposal(text, ctx);
  if (!fallback) return null;
  if (!isObj(raw)) return fallback;

  const projectId = ctx.projects.some((p) => p.id === str(raw.projectId)) ? str(raw.projectId) : fallback.projectId;
  const tasks = cleanTasks(raw.tasks, ctx.today);

  let note = null as CaptureProposal["note"];
  if (isObj(raw.note)) {
    const body = str(raw.note.body);
    const title = str(raw.note.title);
    if (title || body) note = { title: title || deriveTitle(body || text), body: body || text.trim() };
  }
  if (!note && tasks.length === 0) note = fallback.note;

  const byId = new Map(ctx.candidates.map((c) => [c.noteId, c]));
  const linkNoteIds = [
    ...new Set((Array.isArray(raw.linkNoteIds) ? raw.linkNoteIds : []).map(str).filter((id) => byId.has(id))),
  ].slice(0, MAX_LINKS);

  if (note && linkNoteIds.length > 0) {
    const missing = linkNoteIds
      .map((id) => byId.get(id)!.title)
      .filter((title) => !note!.body.includes(`[[${title}]]`));
    if (missing.length > 0) note = { ...note, body: `${note.body}\n\nRelated: ${missing.map((t) => `[[${t}]]`).join(", ")}` };
  }

  return {
    projectId,
    note,
    tasks,
    tagNames: cleanTags(raw.tagNames),
    linkNoteIds,
    reason: str(raw.reason).slice(0, 140) || fallback.reason,
    source: "ai",
  };
}
