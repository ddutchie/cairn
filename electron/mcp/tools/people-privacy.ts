/**
 * Keeps private persona notes out of agent reads (docs/plans/people-layer.md,
 * "Private from agents"). Every model-facing tool result passes through
 * `scrubAgentPrivate` in the consolidated dispatcher, so one place covers chat,
 * coding sessions and MCP, and a new read tool is covered without extra code.
 * `people-privacy.test.ts` walks every read tool to keep it that way.
 */
import type Database from "better-sqlite3";
import { agentHiddenNoteIds } from "../../db/people-queries";

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
export function scrubAgentPrivate(db: Database.Database, result: unknown, args: Record<string, unknown> = {}): unknown {
  const hidden = agentHiddenNoteIds(db);
  if (hidden.size === 0) return result;
  // A read that names a hidden note (get_item, a graph neighbourhood around it) answers as if it didn't exist.
  if (Object.values(args).some((v) => typeof v === "string" && hidden.has(v))) return { error: "Not found" };
  if (isHiddenRef(result, hidden)) return { error: "Not found" };
  return scrub(result, hidden);
}

function isHiddenRef(v: unknown, hidden: Set<string>): boolean {
  if (typeof v === "string") return hidden.has(v);
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return REF_FIELDS.some((f) => typeof o[f] === "string" && hidden.has(o[f] as string));
}

function scrub(v: unknown, hidden: Set<string>): unknown {
  if (Array.isArray(v)) return v.filter((x) => !isHiddenRef(x, hidden)).map((x) => scrub(x, hidden));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" && hidden.has(val)) continue;
    out[k] = scrub(val, hidden);
  }
  return out;
}
