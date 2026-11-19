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
import { isPeopleEnabled } from "../../db/people-queries";
import { refreshMeetingFrontmatter } from "../../people-files";
import { peopleTool, setCardOwnerArg, setNoteAttendees, type PeopleToolContext } from "../../../shared/people/tool";

type Args = Record<string, unknown>;
type Db = Database.Database;

function context(db: Db, workspacePath: string): PeopleToolContext {
  return { enabled: isPeopleEnabled(db), meetingsChanged: (noteIds) => refreshMeetingFrontmatter(db, workspacePath, noteIds) };
}

/** The `people` tool. `workspaceId` is resolved by the dispatcher. */
export function people_tool(db: Db, workspacePath: string, args: Args): unknown {
  return peopleTool(db, context(db, workspacePath), args);
}

/** `attendees` / `date` on `ensure_note` / `update_notes`: make the note a meeting with these attendees. */
export function set_note_attendees(db: Db, workspacePath: string, args: Args): unknown {
  return setNoteAttendees(db, context(db, workspacePath), args);
}

/** `owner` on `create_task` / `update_tasks`: a person id, email or exact name; empty clears. */
export function set_card_owner(db: Db, args: Args): unknown {
  return setCardOwnerArg(db, { enabled: isPeopleEnabled(db) }, args);
}
