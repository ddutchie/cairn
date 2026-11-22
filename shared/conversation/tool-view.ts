/**
 * View-model for the "what changed" body of Cairn's own tool calls. Pure data, so
 * the desktop transcript and the mobile chat render the same facts from the same
 * parsing: each tool's arguments and parsed result become panels of blocks (field
 * rows, +/- diff lines, lists), and a call with nothing better than the raw
 * Arguments / Result gets `null` (the card falls back to those).
 */
import { redactValue } from "../chat/redaction";

type Rec = Record<string, unknown>;

/** One field a call changed, as `from → to`. Executors on both platforms report a list of these in their result. */
export interface ToolChange { id: string; title: string; field: string; from?: string; to?: string }

export interface ChangeRowData { field: string; from?: string; to?: string }
export interface ListItem { name: string; meta?: string; tail?: string }
export interface Hit { title: string; hint?: string }
export interface SentencePart { text: string; strong?: boolean }
export interface DiffRow { sign: "-" | "+"; text: string }

export type ToolBlock =
  | { type: "groups"; groups: Array<{ title: string; rows: ChangeRowData[] }> }
  | { type: "rows"; rows: ChangeRowData[] }
  | { type: "diff"; rows: DiffRow[]; hidden: number }
  | { type: "text"; text: string; muted?: boolean }
  | { type: "caption"; text: string }
  | { type: "heading"; text: string; note?: string }
  | { type: "chips"; items: string[] }
  | { type: "hits"; items: Hit[]; more: number }
  | { type: "list"; items: ListItem[]; more: number }
  | { type: "sentence"; parts: SentencePart[] };

export interface ToolPanelData {
  label: string;
  /** `danger` for a destructive call. */
  tone?: "danger";
  blocks: ToolBlock[];
}

/** The call as both apps hold it: arguments, raw result text, and whether it succeeded. */
export interface ToolCallInput {
  name: string;
  args?: Record<string, unknown>;
  output?: string;
  error?: string;
  ok: boolean;
}

export const SECTION_NAMES: Record<string, string> = {
  "1": "Voice", "2": "Sentence length & rhythm", "3": "Tone & register", "4": "Openings & closings",
  "5": "Punctuation", "6": "Vocabulary & phrases", "7": "Feedback & disagreement", "8": "Emoji",
  "9": "Formatting", "10": "Other patterns", "11": "Anti-patterns", "12": "Voice tells",
};

export const MAX_DIFF_LINES = 10;

function asRec(value: unknown): Rec | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Rec : undefined;
}

/** The result as an object; a top-level array (e.g. a filtered task list) is wrapped as `{ results }`. */
export function parseToolResult(output: string | undefined): Rec | undefined {
  if (!output) return undefined;
  try {
    const value = JSON.parse(output);
    return Array.isArray(value) ? { results: value } : asRec(value);
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : undefined);

function recs(v: unknown): Rec[] {
  return Array.isArray(v) ? v.flatMap((x) => { const r = asRec(x); return r ? [r] : []; }) : [];
}

/** Number of hits in a search result (a top-level array, or `{results}`), or undefined when it isn't one. */
export function searchResultCount(text: string | undefined): number | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object" && Array.isArray((value as { results?: unknown }).results)) return (value as { results: unknown[] }).results.length;
  } catch { /* not JSON */ }
  return undefined;
}

// ── Diff ────────────────────────────────────────────────────────────────────

function linesOf(text: string | undefined): string[] {
  return text === undefined || text === "" ? [] : text.split("\n");
}

/** Removed (−) and added (+) lines. Each non-empty side keeps at least one visible line; the rest is cut with a count of the hidden lines. */
export function diffBlock(removed?: string, added?: string): Extract<ToolBlock, { type: "diff" }> {
  const del = linesOf(removed);
  const add = linesOf(added);
  const reserveAdd = add.length > 0 ? 1 : 0;
  const reserveDel = del.length > 0 ? 1 : 0;
  const delShown = Math.min(del.length, Math.max(reserveDel, MAX_DIFF_LINES - reserveAdd));
  const addShown = Math.min(add.length, Math.max(reserveAdd, MAX_DIFF_LINES - delShown));
  const rows: DiffRow[] = [
    ...del.slice(0, delShown).map((text) => ({ sign: "-" as const, text })),
    ...add.slice(0, addShown).map((text) => ({ sign: "+" as const, text })),
  ];
  return { type: "diff", rows, hidden: del.length + add.length - rows.length };
}

// ── Changes ─────────────────────────────────────────────────────────────────

/** The valid `changes` entries of a result. */
export function changesOf(out: Rec | undefined): ToolChange[] {
  const raw = out?.changes;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    const r = asRec(c);
    return r && str(r.field) ? [{ id: str(r.id) ?? "", title: str(r.title) ?? "Untitled", field: str(r.field)!, from: str(r.from), to: str(r.to) }] : [];
  });
}

/** The comparable fields of a task card, read before and after a call (strings, so `""` means unset). */
export interface CardSnapshot {
  title: string; columnId: string; columnName: string; priority: string; dueDate: string; assignee: string; archived: string;
  /** Titles of the cards blocking this one (sorted), so a dependency change reads as names. */
  blockedBy: string[];
  /** Ids of those cards (sorted): the comparison key, since titles can repeat or be renamed. */
  blockedByIds: string[];
}

const CARD_FIELD_LABELS: Array<[keyof CardSnapshot, string]> = [
  ["title", "title"], ["priority", "priority"], ["dueDate", "due"], ["assignee", "assignee"], ["archived", "archived"],
];

/** The fields that differ between two snapshots of one card, empty when the card was not there both times. */
export function cardChanges(id: string, before: CardSnapshot | undefined, after: CardSnapshot | undefined): ToolChange[] {
  if (!before || !after) return [];
  const out: ToolChange[] = [];
  // Compare the column by id: two columns in a project may share a name.
  if (before.columnId !== after.columnId) out.push({ id, title: after.title, field: "column", from: before.columnName || undefined, to: after.columnName || undefined });
  for (const [key, field] of CARD_FIELD_LABELS) {
    if (before[key] !== after[key]) out.push({ id, title: after.title, field, from: (before[key] as string) || undefined, to: (after[key] as string) || undefined });
  }
  if (before.blockedByIds.join("\u0000") !== after.blockedByIds.join("\u0000")) {
    out.push({ id, title: after.title, field: "blocked by", from: before.blockedBy.join(", ") || undefined, to: after.blockedBy.join(", ") || undefined });
  }
  return out;
}

function groupBlock(changes: ToolChange[]): ToolBlock {
  const groups = new Map<string, ToolChange[]>();
  for (const c of changes) groups.set(c.id || c.title, [...(groups.get(c.id || c.title) ?? []), c]);
  return {
    type: "groups",
    groups: [...groups.values()].map((rows) => ({ title: rows[0].title, rows: rows.map((r) => ({ field: r.field, from: r.from, to: r.to })) })),
  };
}

const rowsBlock = (rows: Array<[string, string]>): ToolBlock => ({ type: "rows", rows: rows.map(([field, to]) => ({ field, to })) });
const panel = (label: string, blocks: ToolBlock[], tone?: "danger"): ToolPanelData => ({ label, blocks, ...(tone ? { tone } : {}) });
const textPanel = (label: string, text: string): ToolPanelData => panel(label, [{ type: "text", text, muted: true }]);

// ── Views ───────────────────────────────────────────────────────────────────

/** `pending`: the call has not run (approval card), so wording must not claim it happened. */
interface ViewContext { pending: boolean }
type View = (args: Rec, out: Rec | undefined, ctx: ViewContext) => ToolPanelData[] | null;

const writingStyle: View = (args, out) => {
  const content = str(out?.content) ?? str(args.content);
  if (!content) return null;
  const sectionKey = str(out?.section) ?? str(args.section);
  const section = sectionKey ? (SECTION_NAMES[sectionKey] ? `${sectionKey} ${SECTION_NAMES[sectionKey]}` : sectionKey) : "End of the guide";
  const unchanged = out?.updated === false;
  return [panel(unchanged ? "Writing style · unchanged" : "Writing style", [
    { type: "caption", text: section },
    unchanged ? { type: "text", text: str(out?.message) ?? "Already in the guide." } : diffBlock(undefined, content),
  ])];
};

const updateTasks: View = (args, out) => {
  const recorded = Array.isArray(out?.changes) ? changesOf(out) : undefined;
  if (recorded && recorded.length > 0) return [panel("Changes", [groupBlock(recorded)])];
  if (recorded) return [textPanel("Changes", "No changes: everything was already set.")];
  // No before/after (approval, or an older result): show what was asked for.
  const rows: Array<[string, string]> = [];
  for (const key of ["title", "priority", "dueDate", "assignee", "columnType"] as const) {
    const v = str(args[key]);
    if (!v) continue;
    // Only enum values read better without underscores; titles and names are shown as written.
    rows.push([key === "dueDate" ? "due" : key === "columnType" ? "column" : key, key === "columnType" ? v.replace("_", " ") : v]);
  }
  if (args.archived === true) rows.push(["archived", "yes"]);
  if (rows.length === 0) return null;
  return [panel("Requested", [rowsBlock(rows)])];
};

const updateNotes: View = (args, out) => {
  const recorded = changesOf(out);
  const requested: ChangeRowData[] = [];
  if (typeof args.folder === "string") requested.push({ field: "folder", to: args.folder.trim() || "(project root)" });
  if (typeof args.isPinned === "boolean") requested.push({ field: "pinned", to: args.isPinned ? "yes" : "no" });
  const tags = Array.isArray(args.tagNames) ? args.tagNames.filter((t): t is string => typeof t === "string") : [];
  if (tags.length) requested.push({ field: args.tagMode === "remove" ? "removed tags" : "tags", to: tags.join(", ") });
  if (recorded.length === 0 && requested.length === 0) return null;
  return [
    ...(recorded.length > 0 ? [panel("Changes", [groupBlock(recorded)])] : []),
    ...(requested.length > 0 ? [panel("Requested", [{ type: "rows" as const, rows: requested }])] : []),
  ];
};

const editNote: View = (args, _out, ctx) => {
  // Same test as the executor: any non-empty oldString (even whitespace) is a patch.
  const removed = typeof args.oldString === "string" && args.oldString.length > 0 ? args.oldString : undefined;
  const added = typeof args.newString === "string" && args.newString.length > 0 ? args.newString : undefined;
  if (!added && !removed) return null;
  return [panel(removed ? (ctx.pending ? "Will edit" : "Edit") : (ctx.pending ? "Will append" : "Appended"), [diffBlock(removed, added)])];
};

const upsertish: View = (args, out) => {
  const rows: Array<[string, string]> = [];
  const add = (field: string, v: unknown) => { const s = str(v); if (s) rows.push([field, s]); };
  add("title", args.title ?? out?.title);
  add("name", args.name);
  add("priority", args.priority);
  add("due", args.dueDate);
  add("column", args.columnType ? String(args.columnType).replace("_", " ") : undefined);
  add("assignee", args.assignee);
  add("folder", args.folder);
  if (Array.isArray(args.tagNames) && args.tagNames.length) add("tags", args.tagNames.join(", "));
  if (rows.length === 0) return null;
  return [panel("Details", [rowsBlock(rows)])];
};

const ideaFlow: View = (args, out, ctx) => {
  const ops = Array.isArray(args.ops) ? args.ops.filter((o): o is Rec => !!asRec(o)) : [];
  if (ops.length === 0) return null;
  // Once it has run, count what the executor applied (a rejected op carries an `error`); before that, what was asked for.
  const outcomes = Array.isArray(out?.results) && out.results.length > 0 ? (out.results as unknown[]).map(asRec) : undefined;
  const count = (op: string) => outcomes
    ? outcomes.filter((r) => r?.op === op && !r?.error).length
    : ops.filter((o) => o.op === op).length;
  const done = [
    [count("add_node"), "node", "added", "add"], [count("update_node"), "node", "updated", "update"], [count("delete_node"), "node", "removed", "remove"],
    [count("add_edge"), "connection", "added", "add"], [count("delete_edge"), "connection", "removed", "remove"],
  ] as const;
  const parts = done.filter(([n]) => n > 0).map(([n, noun, past, future]) => `${n} ${n === 1 ? noun : `${noun}s`} ${ctx.pending ? `to ${future}` : past}`);
  const labels = ops.flatMap((o) => {
    const data = asRec(o.data);
    const l = str(data?.label) ?? str(data?.title) ?? str(data?.text);
    return o.op === "add_node" && l ? [l] : [];
  });
  const failed = outcomes ? outcomes.filter((r) => r?.error).length : 0;
  return [panel(ctx.pending ? "Will change idea flow" : "Idea flow", [
    { type: "text", text: `${parts.join(" · ")}${failed > 0 ? `${parts.length > 0 ? " · " : ""}${failed} failed` : ""}` },
    ...(labels.length > 0 ? [{ type: "chips" as const, items: labels.slice(0, 8) }] : []),
  ])];
};

const progress: View = (args, _out, ctx) => {
  const rows: Array<[string, string]> = [];
  if (args.action === "claim") {
    // A claim ignores message and moveTo, so they are not shown as if they happened.
    rows.push(["claimed by", str(args.agent) ?? "Agent"]);
  } else {
    const message = str(args.message);
    if (message) rows.push(["note", message]);
    const moveTo = str(args.moveTo);
    if (moveTo) rows.push(["moved to", moveTo.replace("_", " ")]);
  }
  if (rows.length === 0) return null;
  return [panel(ctx.pending ? "Will log progress" : "Progress", [rowsBlock(rows)])];
};

function listOf(out: Rec | undefined): unknown[] | undefined {
  return [out?.results, out?.tasks, out?.notes, out?.items].find(Array.isArray) as unknown[] | undefined;
}

function hitsOf(list: unknown[]): Hit[] {
  return list.flatMap((item) => {
    const r = asRec(item);
    const title = r && (str(r.title) ?? str(r.name));
    return title ? [{ title, hint: str(r.folder) ?? str(r.columnName) ?? str(r.priority) }] : [];
  });
}

const search: View = (args, out) => {
  const list = listOf(out);
  if (!list) return null; // not a shape we recognise: use the generic panels
  const hits = hitsOf(list);
  const query = str(args.query);
  if (list.length === 0) return [textPanel("Search", `No results${query ? ` for “${query}”` : ""}.`)];
  if (hits.length === 0) return null;
  const label = `${list.length} result${list.length === 1 ? "" : "s"}${query ? ` for “${query}”` : ""}`;
  return [panel(label, [{ type: "hits", items: hits.slice(0, 5), more: Math.max(0, list.length - 5) }])];
};

const remove: View = (args, _out, ctx) => {
  const kind = str(args.type)?.replace("_", " ");
  if (!kind) return null;
  const id = str(args.id);
  return [panel(ctx.pending ? "Will delete" : "Removed", [{
    type: "sentence",
    parts: [{ text: `${ctx.pending ? `This will delete the ${kind}.` : `A ${kind} was deleted.`} ` }, ...(id ? [{ text: id }] : [])],
  }], "danger")];
};

// ── People ──────────────────────────────────────────────────────────────────

/** Underscores read as spaces in the type only; a custom label in parentheses keeps its own. */
const REL_LABEL = (r: string) => r.replace(/^[a-z_]+/, (type) => type.replace(/_/g, " "));
const EDGE_VERB: Record<string, string> = {
  manager_of: "manages", mentor_of: "mentors", buddy_of: "is buddy of", stakeholder_of: "is stakeholder of", partner: "partners with",
};

const people: View = (args, out, ctx) => {
  const action = str(args.action);
  if (!out && !ctx.pending && action !== "upsert" && action !== "link") return null;
  if (str(out?.error)) return null; // the card's Error panel says it

  if (action === "query") {
    const list = Array.isArray(out?.people) ? recs(out.people) : undefined;
    if (!list) return null;
    if (list.length === 0) return [textPanel("People", "No one matched.")];
    const total = typeof out?.total === "number" ? out.total : list.length;
    const shown = list.slice(0, 8);
    return [panel(`${total} ${total === 1 ? "person" : "people"}`, [{
      type: "list",
      items: shown.map((p) => {
        const rel = Array.isArray(p.relationship) ? (p.relationship as unknown[]).map((r) => REL_LABEL(String(r))).join(", ") : undefined;
        const status = str(p.status);
        return { name: str(p.name) ?? "Unnamed", meta: rel || undefined, tail: status === "suggested" ? "suggested" : str(p.cadence) };
      }),
      more: Math.max(0, total - shown.length),
    }])];
  }

  if (action === "get" && out && str(out.name)) {
    const rel = Array.isArray(out.relationship) ? (out.relationship as unknown[]).map((r) => REL_LABEL(String(r))) : [];
    const relations = recs(out.relations);
    const last = asRec(out.lastMeeting);
    const rows: ChangeRowData[] = [];
    if (str(out.cadence)) rows.push({ field: "1:1", to: str(out.cadence) });
    if (last) rows.push({ field: "last met", to: `${str(last.title) ?? "Meeting"}${str(last.startsAt) ? ` · ${String(last.startsAt).slice(0, 10)}` : ""}` });
    for (const r of relations.slice(0, 4)) rows.push({ field: REL_LABEL(str(r.role) ?? "related"), to: str(r.name) ?? "?" });
    return [panel("Person", [
      { type: "heading", text: str(out.name)!, note: out.isMe === true ? "you" : undefined },
      ...(rel.length > 0 ? [{ type: "chips" as const, items: rel }] : []),
      ...(rows.length > 0 ? [{ type: "rows" as const, rows }] : []),
    ])];
  }

  if (action === "timeline" && out) {
    const group = (k: string) => recs(out[k]);
    const meetings = group("meetings"), mentions = group("mentions"), tasks = group("tasks"), items = group("actionItems");
    if (meetings.length + mentions.length + tasks.length + items.length === 0) return [textPanel("Timeline", "Nothing yet.")];
    const open = items.filter((i) => i.done !== true).length;
    const summary = [
      mentions.length && `${mentions.length} ${mentions.length === 1 ? "note mentions" : "notes mention"} them`,
      tasks.length && `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`,
      items.length && `${open} open checklist ${open === 1 ? "item" : "items"}`,
    ].filter(Boolean).join(" · ");
    const who = str(asRec(out.person)?.name);
    return [panel(`Timeline${who ? ` · ${who}` : ""}`, [
      ...(meetings.length > 0 ? [{
        type: "list" as const,
        items: meetings.slice(0, 5).map((m) => ({ name: str(m.title) ?? "Meeting", tail: str(m.startsAt)?.slice(0, 10) })),
        more: Math.max(0, meetings.length - 5),
      }] : []),
      { type: "caption", text: summary },
    ])];
  }

  if (action === "relationships" && out) {
    if (Array.isArray(out.edges)) {
      const edges = recs(out.edges);
      if (edges.length === 0) return [textPanel("Relationships", "None recorded.")];
      return [panel(`${typeof out.total === "number" ? out.total : edges.length} relationships`, [
        ...edges.slice(0, 8).map((e): ToolBlock => ({
          type: "sentence",
          parts: [
            { text: str(e.sourceName) ?? "", strong: true }, { text: ` ${EDGE_VERB[str(e.type) ?? ""] ?? str(e.type) ?? ""} ` },
            { text: str(e.targetName) ?? "", strong: true },
          ],
        })),
        ...(edges.length > 8 ? [{ type: "caption" as const, text: `+${edges.length - 8} more` }] : []),
      ])];
    }
    const relations = recs(out.relations);
    const who = str(asRec(out.person)?.name);
    return [panel(`Relationships${who ? ` · ${who}` : ""}`, relations.length === 0
      ? [{ type: "text", text: "None recorded.", muted: true }]
      : [{ type: "rows", rows: relations.slice(0, 8).map((r) => ({ field: REL_LABEL(str(r.role) ?? "related"), to: str(r.name) ?? "?" })) }])];
  }

  if (action === "upsert") {
    const person = asRec(out?.person);
    const rows: Array<[string, string]> = [];
    const add = (f: string, v: unknown) => { const s = str(v); if (s) rows.push([f, s]); };
    add("name", args.name ?? person?.name);
    if (Array.isArray(args.relationships) && args.relationships.length) {
      rows.push(["relationship", recs(args.relationships).map((r) => `${REL_LABEL(str(r.type) ?? "")}${str(r.label) ? ` · ${str(r.label)}` : ""}`).join(", ")]);
    }
    add("1:1", args.cadence);
    if (Array.isArray(args.aliases) && args.aliases.length) add("aliases", args.aliases.join(", "));
    if (args.isMe === true) rows.push(["is me", "yes"]);
    if (args.agentPrivate === true) rows.push(["private from agents", "yes"]);
    if (rows.length === 0) return null;
    const label = ctx.pending ? "Will save" : out?.created === true ? "Added to People" : out?.updated === false ? "No changes" : "Saved";
    const suggested = person && str(person.status) === "suggested";
    return [panel(suggested ? `${label} · suggested` : label, [rowsBlock(rows)])];
  }

  if (action === "link") {
    const undo = args.remove === true;
    const edge = asRec(out?.edge);
    if (edge) {
      return [panel(ctx.pending ? "Will link" : undo ? "Unlinked" : "Linked", [{
        type: "sentence",
        parts: [
          { text: str(edge.source) ?? "", strong: true }, { text: ` ${EDGE_VERB[str(edge.type) ?? ""] ?? str(edge.type) ?? ""} ` },
          { text: str(edge.target) ?? "", strong: true },
          ...(str(edge.status) === "suggested" ? [{ text: " suggested" }] : []),
        ],
      }])];
    }
    const attendee = asRec(out?.attendee), mention = asRec(out?.mention);
    const hit = attendee ?? mention;
    if (hit) {
      const label = attendee ? (undo ? (out?.removed === false ? "Still an attendee" : "Attendee removed") : "Attendee added") : (undo ? "Mention removed" : "Mention linked");
      return [panel(label, [{
        type: "sentence",
        parts: [{ text: str(hit.name) ?? "", strong: true }, { text: ` ${attendee ? "on this meeting note" : "in this note"} ` }, { text: str(hit.noteId) ?? "" }],
      }])];
    }
  }
  return null;
};

const VIEWS: Record<string, View> = {
  people,
  update_user_writing_style: writingStyle,
  update_tasks: updateTasks,
  update_notes: updateNotes,
  edit_note: editNote,
  ensure_note: upsertish,
  create_task: upsertish,
  upsert_project: upsertish,
  edit_idea_flow: ideaFlow,
  task_progress: progress,
  search_notes: search,
  search_tasks: search,
  delete: remove,
};

/** Whether a Cairn tool has a purpose-built view (as opposed to the raw call only). */
export function hasCairnToolView(name: string): boolean {
  return name in VIEWS;
}

/** A failed call keeps its specialised view only when the result lists what was applied (partial bulk updates). */
function reportsApplied(out: Rec): boolean {
  return ["changes", "updated", "results"].some((k) => Array.isArray(out[k]) && (out[k] as unknown[]).length > 0);
}

/**
 * The "what changed" panels for a Cairn tool call, or null to use the generic panels.
 * `pending` is for an approval card: nothing has run, so there is no result and the
 * wording is future tense. A failed call still gets its view when it returned a
 * structured result (e.g. the part of a bulk update that did apply).
 */
export function cairnToolView(tc: ToolCallInput, opts: { pending?: boolean } = {}): ToolPanelData[] | null {
  const view = VIEWS[tc.name];
  if (!view) return null;
  const out = parseToolResult(tc.output ?? (tc.ok ? undefined : tc.error));
  if (!tc.ok && !(out && reportsApplied(out))) return null;
  try {
    // Same redaction as the Raw call panel, so a secret in an argument is masked here too.
    const args = (redactValue(tc.args ?? {}) as Rec | undefined) ?? {};
    const panels = view(args, out && (redactValue(out) as Rec), { pending: opts.pending === true });
    return panels && panels.length > 0 ? panels : null;
  } catch {
    return null;
  }
}
