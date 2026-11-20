/**
 * The agent's People tools on the desktop (docs/plans/people-layer.md, "Agent
 * and MCP surface"): the `people` tool and the handlers behind the `attendees`
 * / `date` arguments of the note tools and `owner` on task tools. The logic is
 * `shared/people/tool.ts`, which mobile runs too; this module binds it to the
 * desktop's flag (`app_kv`) and rewrites a meeting note's frontmatter after
 * attendee changes. Private persona notes are removed from results by the
 * dispatcher (`scrubAgentPrivate`), not here.
 */
import type Database from "better-sqlite3";
import "../../../shared/people/place-data";
import { makeFrontmatterReader, refreshMeetingFrontmatter } from "../../people-files";
import { buildInventory } from "../../db/people-migration";
import { peopleTool, setCardOwnerArg, setNoteAttendees, type PeopleToolContext } from "../../../shared/people/tool";

type Args = Record<string, unknown>;
type Db = Database.Database;

function context(db: Db, workspacePath: string): PeopleToolContext {
  return { meetingsChanged: (noteIds) => refreshMeetingFrontmatter(db, workspacePath, noteIds) };
}

/** The `people` tool. `workspaceId` is resolved by the dispatcher. */
export function people_tool(db: Db, workspacePath: string, args: Args): unknown {
  // Desktop-only: the migration scan reads files, which mobile has none of.
  if (args.action === "inventory") return inventoryAction(db, workspacePath, args);
  return peopleTool(db, context(db, workspacePath), args);
}

/**
 * Read-only migration manifest: the person and meeting notes the workspace has,
 * what a migration would do with each, and what is ambiguous. Compact on
 * purpose (names and ids, no reasons or note bodies). Nothing is written; the
 * user applies a migration from the People view.
 */
function inventoryAction(db: Db, workspacePath: string, args: Args): unknown {
  const workspaceId = String(args.workspaceId ?? "");
  if (!workspaceId) return { error: "No workspace found" };
  try {
    const inv = buildInventory(db, workspaceId, { readFrontmatter: makeFrontmatterReader(db, workspacePath, workspaceId) });
    const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 25;
    return {
      counts: inv.counts,
      personas: inv.personas.slice(0, limit).map((c) => ({
        noteId: c.noteId, title: c.title, name: c.name, confidence: c.confidence, action: c.action,
        ...(c.skipReason ? { skipReason: c.skipReason } : {}),
        ...(c.existingPerson ? { existingPerson: c.existingPerson.name } : {}),
        ...(c.suggestedAliases.length ? { suggestedAliases: c.suggestedAliases } : {}),
      })),
      meetings: inv.meetings.slice(0, limit).map((m) => ({
        noteId: m.noteId, title: m.title, ...(m.date ? { date: m.date } : {}),
        unresolved: m.attendees.filter((a) => a.resolution === "unknown" || a.resolution === "ambiguous").map((a) => a.text),
      })),
      ...(inv.ambiguousShortNames.length ? { ambiguousShortNames: inv.ambiguousShortNames.map((a) => a.text) } : {}),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** `attendees` / `date` on `ensure_note` / `update_notes`: make the note a meeting with these attendees. */
export function set_note_attendees(db: Db, workspacePath: string, args: Args): unknown {
  return setNoteAttendees(db, context(db, workspacePath), args);
}

/** `owner` on `create_task` / `update_tasks`: a person id, email or exact name; empty clears. */
export function set_card_owner(db: Db, args: Args): unknown {
  return setCardOwnerArg(db, {}, args);
}
