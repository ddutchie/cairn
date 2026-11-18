"use client";

import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { ToolPanel } from "@/components/shared/ToolCard";
import type { ConversationToolCall } from "@/lib/conversation/message";
import { cn } from "@/lib/utils";

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

function parse(output: string | undefined): Rec | undefined {
  if (!output) return undefined;
  try {
    return asRec(JSON.parse(output));
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

/** Removed (−) and added (+) lines, truncated with a "+N more lines" tail. */
export function DiffLines({ removed, added }: { removed?: string; added?: string }) {
  const rows: Array<{ sign: "-" | "+"; text: string }> = [];
  for (const line of (removed ?? "").split("\n")) if (removed !== undefined && removed !== "") rows.push({ sign: "-", text: line });
  for (const line of (added ?? "").split("\n")) if (added !== undefined && added !== "") rows.push({ sign: "+", text: line });
  const shown = rows.slice(0, MAX_DIFF_LINES);
  return (
    <div className="overflow-hidden rounded border border-[var(--border)] font-mono text-2xs leading-5">
      {shown.map((row, i) => (
        <div
          key={i}
          className={cn("flex gap-1.5 px-1.5", row.sign === "+"
            ? "bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--text-primary)]"
            : "bg-[color-mix(in_srgb,var(--danger)_9%,transparent)] text-[var(--text-secondary)]")}
        >
          <span aria-hidden className={cn("select-none", row.sign === "+" ? "text-[var(--success)]" : "text-[var(--danger)]")}>{row.sign}</span>
          <span className="min-w-0 whitespace-pre-wrap break-words">{row.text || " "}</span>
        </div>
      ))}
      {rows.length > shown.length && <div className="px-1.5 text-[var(--text-tertiary)]">+{rows.length - shown.length} more lines</div>}
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

type View = (tc: ConversationToolCall, args: Rec, out: Rec | undefined) => ReactNode | null;

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
  const changes = changesOf(out);
  if (changes.length > 0) return <ToolPanel label="Changes"><ChangeGroups changes={changes} /></ToolPanel>;
  // No before/after (older results): show what was asked for.
  const rows: Array<[string, string]> = [];
  for (const key of ["title", "priority", "dueDate", "assignee", "columnType"] as const) {
    const v = str(args[key]);
    if (v) rows.push([key === "dueDate" ? "due" : key === "columnType" ? "column" : key, v.replace("_", " ")]);
  }
  if (args.archived === true) rows.push(["archived", "yes"]);
  if (rows.length === 0) return null;
  return <ToolPanel label="Changes"><div className="space-y-0.5">{rows.map(([f, to]) => <ChangeRow key={f} field={f} to={to} />)}</div></ToolPanel>;
};

const updateNotes: View = (_tc, args, out) => {
  const changes = changesOf(out);
  const rows: Array<[string, string | undefined, string | undefined]> = changes.map((c) => [c.field, c.from, c.to]);
  if (typeof args.folder === "string") rows.push(["folder", undefined, args.folder.trim() || "(project root)"]);
  if (typeof args.isPinned === "boolean") rows.push(["pinned", undefined, args.isPinned ? "yes" : "no"]);
  const tags = Array.isArray(args.tagNames) ? args.tagNames.filter((t): t is string => typeof t === "string") : [];
  if (tags.length) rows.push([args.tagMode === "remove" ? "removed tags" : "tags", undefined, tags.join(", ")]);
  if (rows.length === 0) return null;
  return <ToolPanel label="Changes"><div className="space-y-0.5">{rows.map(([f, from, to]) => <ChangeRow key={f} field={f} from={from} to={to} />)}</div></ToolPanel>;
};

const editNote: View = (_tc, args) => {
  const added = str(args.newString);
  const removed = str(args.oldString);
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
  const message = str(args.message);
  const rows: Array<[string, string]> = [];
  if (args.action === "claim") rows.push(["claimed by", str(args.agent) ?? "Agent"]);
  if (message) rows.push(["note", message]);
  const moveTo = str(args.moveTo);
  if (moveTo) rows.push(["moved to", moveTo.replace("_", " ")]);
  if (rows.length === 0) return null;
  return <ToolPanel label="Progress"><div className="space-y-0.5">{rows.map(([f, to]) => <ChangeRow key={f} field={f} to={to} />)}</div></ToolPanel>;
};

function hitsOf(out: Rec | undefined): Array<{ title: string; hint?: string }> {
  const list = [out?.results, out?.tasks, out?.notes, out?.items].find(Array.isArray) as unknown[] | undefined;
  if (!list) return [];
  return list.flatMap((item) => {
    const r = asRec(item);
    const title = r && (str(r.title) ?? str(r.name));
    return title ? [{ title, hint: str(r.folder) ?? str(r.columnName) ?? str(r.priority) }] : [];
  });
}

const search: View = (tc, args, out) => {
  const hits = hitsOf(out);
  const query = str(args.query);
  const label = `${hits.length} result${hits.length === 1 ? "" : "s"}${query ? ` for “${query}”` : ""}`;
  if (hits.length === 0) return <ToolPanel label="Search"><p className="text-2xs text-[var(--text-tertiary)]">No results{query ? ` for “${query}”` : ""}.</p></ToolPanel>;
  void tc;
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
      {hits.length > 5 && <p className="mt-1 text-2xs text-[var(--text-tertiary)]">+{hits.length - 5} more</p>}
    </ToolPanel>
  );
};

const remove: View = (_tc, args) => {
  const kind = str(args.type)?.replace("_", " ");
  if (!kind) return null;
  return (
    <ToolPanel label="Removed" className="border-[color-mix(in_srgb,var(--danger)_35%,var(--border))]">
      <p className="text-2xs text-[var(--text-secondary)]">A {kind} was deleted. <span className="text-[var(--text-tertiary)]">{str(args.id)}</span></p>
    </ToolPanel>
  );
};

const VIEWS: Record<string, View> = {
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

/** The "what changed" panel for a settled Cairn tool call, or null to use the generic panels. */
export function cairnToolView(tc: ConversationToolCall): ReactNode | null {
  const view = VIEWS[tc.name];
  if (!view || !tc.ok) return null;
  try {
    return view(tc, tc.args ?? {}, parse(tc.output));
  } catch {
    return null;
  }
}
