/**
 * Keeps private persona notes out of agent reads (docs/plans/people-layer.md,
 * "Private from agents"). Pure over the set of hidden note ids, so the desktop
 * dispatcher (`electron/mcp/tools/people-privacy.ts`) and the mobile toolset
 * (`mobile/src/chat/tools.ts`) filter identically.
 */

import { isCairnReadTool } from "./tool-names";
import { PEOPLE_READ_ACTIONS } from "./tool-risk";

/** True for a call that only reads: its result is scrubbed of private persona notes, and writes are checked before they run. */
export function isReadCall(name: string, args: Record<string, unknown>): boolean {
  return name === "people" ? PEOPLE_READ_ACTIONS.has(String(args.action)) : isCairnReadTool(name);
}

/**
 * Fields whose value names the item itself or the far end of a link (search
 * hits, graph nodes and edges, link lists): an item whose field is a hidden
 * note goes. Any other field holding a hidden id (a person's `personaNoteId`)
 * is just cleared, so the private person still shows, without their note.
 */
const REF_FIELDS = ["id", "noteId", "source", "target", "sourceId", "targetId", "sourceNoteId", "targetNoteId"];

/**
 * Drop every reference to a hidden note from a tool result: array items that
 * are (or point at) a hidden note are removed, and a field holding a hidden
 * note id is cleared. A result that IS a hidden note becomes "not found", the
 * same answer as for a note that doesn't exist.
 */
export function scrubHidden(hidden: ReadonlySet<string>, result: unknown, args: Record<string, unknown> = {}): unknown {
  if (hidden.size === 0) return result;
  // A read that names a hidden note (get_item, a graph neighbourhood around it) answers as if it didn't exist.
  if (namesHiddenNote(args, hidden)) return { error: "Not found" };
  if (isHiddenRef(result, hidden)) return { error: "Not found" };
  return scrub(result, hidden);
}

function isHiddenRef(v: unknown, hidden: ReadonlySet<string>): boolean {
  if (typeof v === "string") return hidden.has(v);
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return REF_FIELDS.some((f) => typeof o[f] === "string" && hidden.has(o[f] as string));
}

function scrub(v: unknown, hidden: ReadonlySet<string>): unknown {
  if (Array.isArray(v)) return v.filter((x) => !isHiddenRef(x, hidden)).map((x) => scrub(x, hidden));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" && hidden.has(val)) continue;
    // A single nested object that is (or points at) a hidden note goes whole, not just its id key.
    if (val && typeof val === "object" && !Array.isArray(val) && isHiddenRef(val, hidden)) continue;
    out[k] = scrub(val, hidden);
  }
  return out;
}

/** True when any argument (a string, or strings inside arrays) is a hidden note's id. */
function namesHiddenNote(args: unknown, hidden: ReadonlySet<string>): boolean {
  if (typeof args === "string") return hidden.has(args);
  if (Array.isArray(args)) return args.some((v) => namesHiddenNote(v, hidden));
  if (args && typeof args === "object") return Object.values(args as Record<string, unknown>).some((v) => namesHiddenNote(v, hidden));
  return false;
}

/**
 * Guard for agent WRITES: a call naming a hidden note (by id, or by the title
 * `ensure_note` would match) is refused before anything runs, so the model can
 * neither edit a persona note nor learn its id through a write result.
 */
export function refusesHiddenNoteWrite(
  hidden: ReadonlySet<string>,
  name: string,
  args: Record<string, unknown>,
  /** The id of the live note `ensure_note` would match by (project, title), if any. */
  findNoteIdByTitle: (projectId: string, title: string) => string | undefined,
): { error: string } | null {
  if (hidden.size === 0) return null;
  if (namesHiddenNote(args, hidden)) return { error: "Not found" };
  if (name === "ensure_note" && typeof args.projectId === "string" && typeof args.title === "string") {
    const existingId = findNoteIdByTitle(args.projectId, args.title);
    if (existingId && hidden.has(existingId)) return { error: `A note titled "${args.title}" can't be used here. Pick another title.` };
  }
  return null;
}
