/**
 * What the People layer adds to the agent toolset, in one place for desktop
 * (`electron/lib/tool-schemas.ts`) and mobile (`mobile/src/chat/tools.ts`):
 * the `people` tool's words and the descriptions of its arguments.
 */

/** What the three argument kinds say to the model (same words on every surface). */
export const PEOPLE_ARG_DESCRIPTIONS = {
  attendees: "Meeting notes: who attended (names, emails or person ids). Makes the note a meeting; replaces the attendees you declared before",
  date: "Meeting notes: when it happened (YYYY-MM-DD or ISO datetime)",
  owner: "Person who owns this task (name, email or person id), or empty to clear",
} as const;

/** The profile fields `upsert` can set (same words on every surface). */
export const PROFILE_FIELD_DESCRIPTIONS = {
  title: "upsert: job title or role, e.g. 'Senior Software Engineer'. Fills a gap; never replaces what the user set unless provenance is explicit",
  team: "upsert: the person's team or org, e.g. 'Sync' (joins that team); teams/team_upsert: the team's name",
  location: "upsert: where they are, e.g. 'Berlin, Germany'",
  timezone: "upsert: IANA time zone, e.g. 'Europe/Berlin'",
  slackId: "upsert: their Slack member id (U0123ABCD), used to read their Slack profile",
} as const;

/** What `label` on a relationship means (same words on every surface). */
export const RELATIONSHIP_LABEL_DESCRIPTION =
  "Optional short qualifier for this one type, e.g. 'executive sponsor' on a stakeholder. One phrase, never a list and never another type: give each relationship its own entry with its own type";

/** What `teamInfo` on `team_upsert` holds (same words on every surface). */
export const TEAM_INFO_DESCRIPTION =
  "team_upsert: the team's details. Every field is optional; empty string clears. description: what the team owns and works on; lead: person name or id; parentTeam: the team it sits under (created if new); channel: e.g. '#sync'; links: [{label, url}] (replaces the list); members: person names or ids to put on this team; rename: a new name (members move with it)";

/** The `people` tool's description for the model. */
export const PEOPLE_TOOL_DESCRIPTION =
  "People the user works with, their meetings and relationships. Reads: 'query' (by name, relationship or status; empty lists everyone), 'get' (one person: details, relationships, persona note id), 'timeline' (their meetings, mentions and owned tasks, newest first), 'relationships' (who manages/mentors/partners whom). 'teams' (every team with its lead, parent team, members and details; pass team for one). Writes: 'upsert' (create or update a person), 'link' (an edge between two people, an attendee on a meeting note, or a mention) and 'team_upsert' (create or update a team's details and members). Anything you infer rather than read stated goes in as status 'suggested' for the user to confirm.";

/**
 * Desktop adds the read-only `inventory` action (a scan of person and meeting notes
 * for migration, which reads files); mobile has no such action, so it never says so.
 */
export const PEOPLE_TOOL_DESCRIPTION_DESKTOP = PEOPLE_TOOL_DESCRIPTION.replace(
  "'relationships' (who manages/mentors/partners whom).",
  "'relationships' (who manages/mentors/partners whom), 'inventory' (read-only scan of the person and meeting notes already in the workspace, for migrating them; the user applies it).",
);
