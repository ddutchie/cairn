"use client";

import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { ToolPanel } from "@/components/shared/ToolCard";
import type { ConversationToolCall } from "@/lib/conversation/message";
import { cn } from "@/lib/utils";
import { redactTranscriptValue } from "@/lib/redact-agent-transcript";

/**
 * Purpose-built "what changed" bodies for Cairn's own tools. Each view reads the
 * call's arguments and parsed result and returns a panel, or null when there is
 * nothing better than the generic Arguments / Result tree (the card falls back).
 */

type Rec = Record<string, unknown>;

const SECTION_NAMES: Record<string, string> = {
  "1": "Voice", "2": "Sentence length & rhythm", "3": "Tone & register", "4": "Openings & closings",
  "5": "Punctuation", "6": "Vocabulary & phrases", "7": "Feedback & disagreement", "8": "Emoji",
  "9": "Formatting", "10": "Other patterns", "11": "Anti-patterns", "12": "Voice tells",
};

function asRec(value: unknown): Rec | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Rec : undefined;
}

/** The result as an object; a top-level array (e.g. a filtered task list) is wrapped as `{ results }`. */
function parse(output: string | undefined): Rec | undefined {
  if (!output) return undefined;
  try {
    const value = JSON.parse(output);
    return Array.isArray(value) ? { results: value } : asRec(value);
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : undefined);

// ── Primitives ──────────────────────────────────────────────────────────────

/** A single `field  from → to` row. */
export function ChangeRow({ field, from, to }: { field: string; from?: string; to?: string }) {
  return (
    <div className="grid grid-cols-[minmax(4.5rem,24%)_1fr] items-baseline gap-2 text-2xs">
      <span className="text-[var(--text-tertiary)]">{field}</span>
      <span className="min-w-0 break-words text-[var(--text-secondary)]">
        {from !== undefined && <span className="text-[var(--text-tertiary)] line-through decoration-[color-mix(in_srgb,var(--text-tertiary)_60%,transparent)]">{from}</span>}
        {from !== undefined && to !== undefined && <ArrowRight size={9} className="mx-1 inline text-[var(--text-tertiary)]" />}
        {to !== undefined && <span className="font-medium text-[var(--text-primary)]">{to}</span>}
      </span>
    </div>
  );
}

const MAX_DIFF_LINES = 10;

function linesOf(text: string | undefined): string[] {
  return text === undefined || text === "" ? [] : text.split("\n");
}

/** Removed (−) and added (+) lines. Each non-empty side keeps at least one visible line; the rest is cut with a "+N more lines" tail. */
export function DiffLines({ removed, added }: { removed?: string; added?: string }) {
  const del = linesOf(removed);
  const add = linesOf(added);
  const reserveAdd = add.length > 0 ? 1 : 0;
  const reserveDel = del.length > 0 ? 1 : 0;
  const delShown = Math.min(del.length, Math.max(reserveDel, MAX_DIFF_LINES - reserveAdd));
  const addShown = Math.min(add.length, Math.max(reserveAdd, MAX_DIFF_LINES - delShown));
  const rows: Array<{ sign: "-" | "+"; text: string }> = [
    ...del.slice(0, delShown).map((text) => ({ sign: "-" as const, text })),
    ...add.slice(0, addShown).map((text) => ({ sign: "+" as const, text })),
  ];
  const hidden = del.length + add.length - rows.length;
  return (
    <div className="overflow-hidden rounded border border-[var(--border)] font-mono text-2xs leading-5">
      {rows.map((row, i) => (
        <div
          key={i}
          className={cn("flex gap-1.5 px-1.5", row.sign === "+"
            ? "bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--text-primary)]"
            : "bg-[color-mix(in_srgb,var(--danger)_9%,transparent)] text-[var(--text-secondary)]")}
        >
          <span aria-hidden className={cn("select-none", row.sign === "+" ? "text-[var(--success)]" : "text-[var(--danger)]")}>{row.sign}</span>
          <span className="sr-only">{row.sign === "+" ? "Added: " : "Removed: "}</span>
          <span className="min-w-0 whitespace-pre-wrap break-words">{row.text || " "}</span>
        </div>
      ))}
      {hidden > 0 && <div className="px-1.5 text-[var(--text-tertiary)]">+{hidden} more lines</div>}
    </div>
  );
}

function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item, i) => (
        <span key={`${item}-${i}`} className="max-w-full truncate rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-2xs text-[var(--text-secondary)]">{item}</span>
      ))}
    </div>
  );
}

// ── Views ───────────────────────────────────────────────────────────────────

/** `pending`: the call has not run (approval card), so wording must not claim it happened. */
interface ViewContext { pending: boolean }
type View = (tc: ConversationToolCall, args: Rec, out: Rec | undefined, ctx: ViewContext) => ReactNode | null;

const writingStyle: View = (_tc, args, out) => {
  const content = str(out?.content) ?? str(args.content);
  if (!content) return null;
  const sectionKey = str(out?.section) ?? str(args.section);
  const section = sectionKey ? (SECTION_NAMES[sectionKey] ? `${sectionKey} ${SECTION_NAMES[sectionKey]}` : sectionKey) : "End of the guide";
  const unchanged = out?.updated === false;
  return (
    <ToolPanel label={unchanged ? "Writing style · unchanged" : "Writing style"}>
      <p className="mb-1 text-2xs text-[var(--text-tertiary)]">{section}</p>
      {unchanged
        ? <p className="text-2xs text-[var(--text-secondary)]">{str(out?.message) ?? "Already in the guide."}</p>
        : <DiffLines added={content} />}
    </ToolPanel>
  );
};

interface Change { id: string; title: string; field: string; from?: string; to?: string }

function changesOf(out: Rec | undefined): Change[] {
  const raw = out?.changes;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    const r = asRec(c);
    return r && str(r.field) ? [{ id: str(r.id) ?? "", title: str(r.title) ?? "Untitled", field: str(r.field)!, from: str(r.from), to: str(r.to) }] : [];
  });
}

function ChangeGroups({ changes }: { changes: Change[] }) {
  const groups = new Map<string, Change[]>();
  for (const c of changes) groups.set(c.id || c.title, [...(groups.get(c.id || c.title) ?? []), c]);
  return (
    <div className="space-y-1.5">
      {[...groups.values()].map((rows) => (
        <div key={rows[0].id || rows[0].title}>
          <p className="truncate text-xs font-medium text-[var(--text-primary)]">{rows[0].title}</p>
          <div className="mt-0.5 space-y-0.5 border-l border-[var(--border)] pl-2">
            {rows.map((r) => <ChangeRow key={r.field} field={r.field} from={r.from} to={r.to} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

const updateTasks: View = (_tc, args, out) => {
  const recorded = Array.isArray(out?.changes) ? changesOf(out) : undefined;
  if (recorded && recorded.length > 0) return <ToolPanel label="Changes"><ChangeGroups changes={recorded} /></ToolPanel>;
  if (recorded) return <ToolPanel label="Changes"><p className="text-2xs text-[var(--text-tertiary)]">No changes: everything was already set.</p></ToolPanel>;
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
  return <ToolPanel label="Requested"><div className="space-y-0.5">{rows.map(([f, to]) => <ChangeRow key={f} field={f} to={to} />)}</div></ToolPanel>;
};

const updateNotes: View = (_tc, args, out) => {
  const recorded = changesOf(out);
  const requested: Array<[string, string | undefined, string | undefined]> = [];
  if (typeof args.folder === "string") requested.push(["folder", undefined, args.folder.trim() || "(project root)"]);
  if (typeof args.isPinned === "boolean") requested.push(["pinned", undefined, args.isPinned ? "yes" : "no"]);
  const tags = Array.isArray(args.tagNames) ? args.tagNames.filter((t): t is string => typeof t === "string") : [];
  if (tags.length) requested.push([args.tagMode === "remove" ? "removed tags" : "tags", undefined, tags.join(", ")]);
  if (recorded.length === 0 && requested.length === 0) return null;
  return (
    <>
      {recorded.length > 0 && <ToolPanel label="Changes"><ChangeGroups changes={recorded} /></ToolPanel>}
      {requested.length > 0 && (
        <ToolPanel label="Requested"><div className="space-y-0.5">{requested.map(([f, from, to]) => <ChangeRow key={f} field={f} from={from} to={to} />)}</div></ToolPanel>
      )}
    </>
  );
};

const editNote: View = (_tc, args) => {
  // Same test as the executor: any non-empty oldString (even whitespace) is a patch.
  const removed = typeof args.oldString === "string" && args.oldString.length > 0 ? args.oldString : undefined;
  const added = typeof args.newString === "string" && args.newString.length > 0 ? args.newString : undefined;
  if (!added && !removed) return null;
  return (
    <ToolPanel label={removed ? "Edit" : "Appended"}>
      <DiffLines removed={removed} added={added} />
    </ToolPanel>
  );
};

const upsertish: View = (_tc, args, out) => {
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
  return <ToolPanel label="Details"><div className="space-y-0.5">{rows.map(([f, to]) => <ChangeRow key={f} field={f} to={to} />)}</div></ToolPanel>;
};

const ideaFlow: View = (_tc, args, out) => {
  const ops = Array.isArray(args.ops) ? args.ops.filter((o): o is Rec => !!asRec(o)) : [];
  if (ops.length === 0) return null;
  const count = (op: string) => ops.filter((o) => o.op === op).length;
  const parts = [
    [count("add_node"), "node added"], [count("update_node"), "node updated"], [count("delete_node"), "node removed"],
    [count("add_edge"), "connection added"], [count("delete_edge"), "connection removed"],
  ].filter(([n]) => (n as number) > 0).map(([n, label]) => `${n} ${label}`.replace(/(\d+) (\w+) (\w+)/, (_m, c, a, b) => `${c} ${Number(c) === 1 ? a : `${a}s`} ${b}`));
  const labels = ops.flatMap((o) => {
    const data = asRec(o.data);
    const l = str(data?.label) ?? str(data?.title) ?? str(data?.text);
    return o.op === "add_node" && l ? [l] : [];
  });
  const failed = Array.isArray(out?.results) ? (out!.results as unknown[]).filter((r) => asRec(r)?.error).length : 0;
  return (
    <ToolPanel label="Idea flow">
      <p className="text-2xs text-[var(--text-secondary)]">{parts.join(" · ")}{failed > 0 ? ` · ${failed} failed` : ""}</p>
      {labels.length > 0 && <div className="mt-1"><Chips items={labels.slice(0, 8)} /></div>}
    </ToolPanel>
  );
};

const progress: View = (_tc, args) => {
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
  return <ToolPanel label="Progress"><div className="space-y-0.5">{rows.map(([f, to]) => <ChangeRow key={f} field={f} to={to} />)}</div></ToolPanel>;
};

function listOf(out: Rec | undefined): unknown[] | undefined {
  return [out?.results, out?.tasks, out?.notes, out?.items].find(Array.isArray) as unknown[] | undefined;
}

function hitsOf(list: unknown[]): Array<{ title: string; hint?: string }> {
  return list.flatMap((item) => {
    const r = asRec(item);
    const title = r && (str(r.title) ?? str(r.name));
    return title ? [{ title, hint: str(r.folder) ?? str(r.columnName) ?? str(r.priority) }] : [];
  });
}

const search: View = (_tc, args, out) => {
  const list = listOf(out);
  if (!list) return null; // not a shape we recognise: use the generic panels
  const hits = hitsOf(list);
  const query = str(args.query);
  if (list.length === 0) return <ToolPanel label="Search"><p className="text-2xs text-[var(--text-tertiary)]">No results{query ? ` for “${query}”` : ""}.</p></ToolPanel>;
  if (hits.length === 0) return null;
  const label = `${list.length} result${list.length === 1 ? "" : "s"}${query ? ` for “${query}”` : ""}`;
  return (
    <ToolPanel label={label}>
      <ul className="space-y-0.5">
        {hits.slice(0, 5).map((h, i) => (
          <li key={`${h.title}-${i}`} className="flex items-baseline justify-between gap-2 text-2xs">
            <span className="min-w-0 truncate text-[var(--text-primary)]">{h.title}</span>
            {h.hint && <span className="shrink-0 text-[var(--text-tertiary)]">{h.hint}</span>}
          </li>
        ))}
      </ul>
      {list.length > 5 && <p className="mt-1 text-2xs text-[var(--text-tertiary)]">+{list.length - 5} more</p>}
    </ToolPanel>
  );
};

const remove: View = (_tc, args, _out, ctx) => {
  const kind = str(args.type)?.replace("_", " ");
  if (!kind) return null;
  return (
    <ToolPanel label={ctx.pending ? "Will delete" : "Removed"} className="border-[color-mix(in_srgb,var(--danger)_35%,var(--border))]">
      <p className="text-2xs text-[var(--text-secondary)]">{ctx.pending ? `This will delete the ${kind}.` : `A ${kind} was deleted.`} <span className="text-[var(--text-tertiary)]">{str(args.id)}</span></p>
    </ToolPanel>
  );
};

// ── People ──────────────────────────────────────────────────────────────────

/** The object items of an array value (anything else is dropped). */
function recs(v: unknown): Rec[] {
  return Array.isArray(v) ? v.flatMap((x) => { const r = asRec(x); return r ? [r] : []; }) : [];
}

const REL_LABEL = (r: string) => r.replace(/_/g, " ");
const EDGE_VERB: Record<string, string> = {
  manager_of: "manages", mentor_of: "mentors", buddy_of: "is buddy of", stakeholder_of: "is stakeholder of", partner: "partners with",
};

function PersonLine({ name, meta, tail }: { name: string; meta?: string; tail?: string }) {
  return (
    <li className="flex items-baseline justify-between gap-2 text-2xs">
      <span className="min-w-0 truncate"><span className="font-medium text-[var(--text-primary)]">{name}</span>{meta && <span className="ml-1.5 text-[var(--text-tertiary)]">{meta}</span>}</span>
      {tail && <span className="shrink-0 text-[var(--text-tertiary)]">{tail}</span>}
    </li>
  );
}

function more(n: number, shown: number) {
  return n > shown ? <p className="mt-1 text-2xs text-[var(--text-tertiary)]">+{n - shown} more</p> : null;
}

const people: View = (_tc, args, out, ctx) => {
  const action = str(args.action);
  if (!out && !ctx.pending && action !== "upsert" && action !== "link") return null;
  const err = str(out?.error);
  if (err) return null; // the card's Error panel says it

  if (action === "query") {
    const list = Array.isArray(out?.people) ? recs(out.people) : undefined;
    if (!list) return null;
    if (list.length === 0) return <ToolPanel label="People"><p className="text-2xs text-[var(--text-tertiary)]">No one matched.</p></ToolPanel>;
    const total = typeof out?.total === "number" ? out.total : list.length;
    return (
      <ToolPanel label={`${total} ${total === 1 ? "person" : "people"}`}>
        <ul className="space-y-0.5">
          {list.slice(0, 8).map((p, i) => {
            const rel = Array.isArray(p.relationship) ? (p.relationship as unknown[]).map((r) => REL_LABEL(String(r))).join(", ") : undefined;
            const status = str(p.status);
            return <PersonLine key={`${str(p.id)}-${i}`} name={str(p.name) ?? "Unnamed"} meta={rel} tail={status === "suggested" ? "suggested" : str(p.cadence)} />;
          })}
        </ul>
        {more(total, Math.min(list.length, 8))}
      </ToolPanel>
    );
  }

  if (action === "get" && out && str(out.name)) {
    const rel = Array.isArray(out.relationship) ? (out.relationship as unknown[]).map((r) => REL_LABEL(String(r))) : [];
    const relations = recs(out.relations);
    const last = asRec(out.lastMeeting);
    return (
      <ToolPanel label="Person">
        <p className="text-xs font-medium text-[var(--text-primary)]">{str(out.name)}{out.isMe === true && <span className="ml-1.5 text-2xs font-normal text-[var(--text-tertiary)]">you</span>}</p>
        {rel.length > 0 && <div className="mt-1"><Chips items={rel} /></div>}
        <div className="mt-1.5 space-y-0.5">
          {str(out.cadence) && <ChangeRow field="1:1" to={str(out.cadence)} />}
          {last && <ChangeRow field="last met" to={`${str(last.title) ?? "Meeting"}${str(last.startsAt) ? ` · ${String(last.startsAt).slice(0, 10)}` : ""}`} />}
          {relations.slice(0, 4).map((r, i) => <ChangeRow key={i} field={REL_LABEL(str(r.role) ?? "related")} to={str(r.name) ?? "?"} />)}
        </div>
      </ToolPanel>
    );
  }

  if (action === "timeline" && out) {
    const group = (k: string) => recs(out[k]);
    const meetings = group("meetings"), mentions = group("mentions"), tasks = group("tasks"), items = group("actionItems");
    if (meetings.length + mentions.length + tasks.length + items.length === 0) return <ToolPanel label="Timeline"><p className="text-2xs text-[var(--text-tertiary)]">Nothing yet.</p></ToolPanel>;
    return (
      <ToolPanel label={`Timeline${str(asRec(out.person)?.name) ? ` · ${str(asRec(out.person)?.name)}` : ""}`}>
        {meetings.length > 0 && (
          <ul className="space-y-0.5">
            {meetings.slice(0, 5).map((m, i) => <PersonLine key={i} name={str(m.title) ?? "Meeting"} tail={str(m.startsAt)?.slice(0, 10)} />)}
          </ul>
        )}
        {more(meetings.length, 5)}
        <p className="mt-1 text-2xs text-[var(--text-tertiary)]">
          {[mentions.length && `${mentions.length} ${mentions.length === 1 ? "note mentions" : "notes mention"} them`, tasks.length && `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`, items.length && `${items.filter((i) => i.done !== true).length} open checklist ${items.filter((i) => i.done !== true).length === 1 ? "item" : "items"}`].filter(Boolean).join(" · ")}
        </p>
      </ToolPanel>
    );
  }

  if (action === "relationships" && out) {
    if (Array.isArray(out.edges)) {
      const edges = recs(out.edges);
      if (edges.length === 0) return <ToolPanel label="Relationships"><p className="text-2xs text-[var(--text-tertiary)]">None recorded.</p></ToolPanel>;
      return (
        <ToolPanel label={`${typeof out.total === "number" ? out.total : edges.length} relationships`}>
          <ul className="space-y-0.5">
            {edges.slice(0, 8).map((e, i) => (
              <li key={i} className="min-w-0 truncate text-2xs text-[var(--text-secondary)]">
                <span className="text-[var(--text-primary)]">{str(e.sourceName)}</span> {EDGE_VERB[str(e.type) ?? ""] ?? str(e.type)} <span className="text-[var(--text-primary)]">{str(e.targetName)}</span>
              </li>
            ))}
          </ul>
          {more(edges.length, 8)}
        </ToolPanel>
      );
    }
    const relations = recs(out.relations);
    return (
      <ToolPanel label={`Relationships${str(asRec(out.person)?.name) ? ` · ${str(asRec(out.person)?.name)}` : ""}`}>
        {relations.length === 0
          ? <p className="text-2xs text-[var(--text-tertiary)]">None recorded.</p>
          : <div className="space-y-0.5">{relations.slice(0, 8).map((r, i) => <ChangeRow key={i} field={REL_LABEL(str(r.role) ?? "related")} to={str(r.name) ?? "?"} />)}</div>}
      </ToolPanel>
    );
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
    return <ToolPanel label={suggested ? `${label} · suggested` : label}><div className="space-y-0.5">{rows.map(([f, to]) => <ChangeRow key={f} field={f} to={to} />)}</div></ToolPanel>;
  }

  if (action === "link") {
    const undo = args.remove === true;
    const edge = asRec(out?.edge);
    if (edge) {
      return (
        <ToolPanel label={ctx.pending ? "Will link" : undo ? "Unlinked" : "Linked"}>
          <p className="text-2xs text-[var(--text-secondary)]"><span className="text-[var(--text-primary)]">{str(edge.source)}</span> {EDGE_VERB[str(edge.type) ?? ""] ?? str(edge.type)} <span className="text-[var(--text-primary)]">{str(edge.target)}</span>{str(edge.status) === "suggested" && <span className="ml-1.5 text-[var(--text-tertiary)]">suggested</span>}</p>
        </ToolPanel>
      );
    }
    const attendee = asRec(out?.attendee), mention = asRec(out?.mention);
    const hit = attendee ?? mention;
    if (hit) {
      return (
        <ToolPanel label={attendee ? (undo ? "Attendee removed" : "Attendee added") : (undo ? "Mention removed" : "Mention linked")}>
          <p className="text-2xs text-[var(--text-secondary)]"><span className="text-[var(--text-primary)]">{str(hit.name)}</span> {attendee ? "on this meeting note" : "in this note"} <span className="text-[var(--text-tertiary)]">{str(hit.noteId)}</span></p>
        </ToolPanel>
      );
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

/**
 * The "what changed" panel for a Cairn tool call, or null to use the generic panels.
 * `pending` is for an approval card: nothing has run, so there is no result and the
 * wording is future tense. A failed call still gets its view when it returned a
 * structured result (e.g. the part of a bulk update that did apply).
 */
/** A failed call keeps its specialised view only when the result lists what was applied (partial bulk updates). */
function reportsApplied(out: Rec): boolean {
  return ["changes", "updated", "results"].some((k) => Array.isArray(out[k]) && (out[k] as unknown[]).length > 0);
}

export function cairnToolView(tc: ConversationToolCall, opts: { pending?: boolean } = {}): ReactNode | null {
  const view = VIEWS[tc.name];
  if (!view) return null;
  const out = parse(tc.output ?? (tc.ok ? undefined : tc.error));
  if (!tc.ok && !(out && reportsApplied(out))) return null;
  try {
    // Same redaction as the Raw call panel, so a secret in an argument is masked here too.
    const args = (redactTranscriptValue(tc.args ?? {}) as Rec | undefined) ?? {};
    return view(tc, args, out, { pending: opts.pending === true });
  } catch {
    return null;
  }
}
