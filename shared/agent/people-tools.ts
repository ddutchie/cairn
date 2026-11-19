/**
 * What the People layer adds to the agent toolset, in one place for desktop
 * (`electron/lib/tool-schemas.ts`, `toolSchemasFor`) and mobile
 * (`mobile/src/chat/tools.ts`). Both leave these out while `feature.people` is
 * off, so the feature is invisible until launch. The list is read once when a
 * session starts: a session's tool list never changes (prompt-cache rule).
 */

/** Tools that exist only while the People layer is on. */
export const PEOPLE_TOOLS: ReadonlySet<string> = new Set(["people"]);

/** Arguments of other tools that exist only while the People layer is on. */
export const PEOPLE_TOOL_ARGS: Readonly<Record<string, readonly string[]>> = {
  ensure_note:  ["attendees", "date"],
  update_notes: ["attendees", "date"],
  create_task:  ["owner"],
  update_tasks: ["owner"],
};

/** What the three argument kinds say to the model (same words on every surface). */
export const PEOPLE_ARG_DESCRIPTIONS = {
  attendees: "Meeting notes: who attended (names, emails or person ids). Makes the note a meeting; replaces the attendees you declared before",
  date: "Meeting notes: when it happened (YYYY-MM-DD or ISO datetime)",
  owner: "Person who owns this task (name, email or person id), or empty to clear",
} as const;

/** What `label` on a relationship means (same words on every surface). */
export const RELATIONSHIP_LABEL_DESCRIPTION =
  "Optional short qualifier for this one type, e.g. 'executive sponsor' on a stakeholder. One phrase, never a list and never another type: give each relationship its own entry with its own type";

/** The `people` tool's description for the model. */
export const PEOPLE_TOOL_DESCRIPTION =
  "People the user works with, their meetings and relationships. Reads: 'query' (by name, relationship or status; empty lists everyone), 'get' (one person: details, relationships, persona note id), 'timeline' (their meetings, mentions and owned tasks, newest first), 'relationships' (who manages/mentors/partners whom). Writes: 'upsert' (create or update a person) and 'link' (an edge between two people, an attendee on a meeting note, or a mention). Anything you infer rather than read stated goes in as status 'suggested' for the user to confirm.";

/**
 * Desktop adds the read-only `inventory` action (a scan of person and meeting notes
 * for migration, which reads files); mobile has no such action, so it never says so.
 */
export const PEOPLE_TOOL_DESCRIPTION_DESKTOP = PEOPLE_TOOL_DESCRIPTION.replace(
  "'relationships' (who manages/mentors/partners whom).",
  "'relationships' (who manages/mentors/partners whom), 'inventory' (read-only scan of the person and meeting notes already in the workspace, for migrating them; the user applies it).",
);
