/**
 * What the People layer adds to the agent toolset, in one place for desktop
 * (`electron/lib/tool-schemas.ts`) and mobile (`mobile/src/chat/tools.ts`):
 * the `people` tool's words and the descriptions of its arguments.
 *
 * These words go out with every request, so they are kept short: the tool
 * description is an index of actions, and anything that belongs to one
 * argument is said once, on that argument.
 */

/** What the three argument kinds say to the model (same words on every surface). */
export const PEOPLE_ARG_DESCRIPTIONS = {
  attendees: "Meeting notes: who attended (names, emails or person ids). Makes the note a meeting; replaces the attendees you declared before",
  date: "Meeting notes: when it happened (YYYY-MM-DD or ISO datetime)",
  owner: "Person who owns this task (name, email or person id), or empty to clear",
} as const;

/** Every described argument of the `people` tool (same words on every surface). */
export const PEOPLE_PARAM_DESCRIPTIONS = {
  personId: "The person (or pass name). merge: the one kept",
  name: "query: name filter; get/upsert: the person's name",
  relationship: "query: only people with this relationship to the user, e.g. manager",
  status: "query: filter. Writes: confirmed (default) when stated, may replace what the user set; suggested when inferred, only fills gaps",
  aliases: "upsert: other names, added",
  emails: "upsert: addresses, added",
  relationships: "upsert: relationships to the user, replacing the list. manager, direct_report, mentor, buddy and stakeholder are also edges to the user, so don't link them again",
  relationshipLabel: "One short qualifier, e.g. 'executive sponsor'. Never a list or another type: each type is its own entry",
  cadence: "upsert: 1:1 cadence; empty clears",
  title: "upsert: job title, e.g. 'Staff Engineer'",
  team: "upsert: home team (moves them off other teams; guilds and projects stay). teams (omit for all), team_upsert, team_delete: name or teamId",
  teamInfo: "team_upsert; all optional, empty string clears. kind: team (default; one home team each), guild, project or committee. lead: also joins. parentTeam: an existing team. links replaces the list. members: join (nobody moves); role: theirs on this team. removeMembers: leave, kept as history. mergeInto: a team to fold this one into",
  location: "upsert: e.g. 'Berlin, Germany'",
  timezone: "upsert: IANA zone, e.g. 'Europe/Berlin'",
  slackId: "upsert: Slack member id (U0123ABCD)",
  personaNoteId: "upsert: the note about them",
  link: "An edge, personId <link> otherPersonId; or attendee/mention, personId on noteId",
  otherPersonId: "Edge: the other person; merge: the duplicate, removed",
  endedAt: "Edge: YYYY-MM-DD, ISO or 'now' marks it former; omit for current",
  label: "Edge: qualifier, e.g. 'dotted line'",
  noteId: "attendee/mention: the note",
  remove: "link: delete (endedAt keeps history instead); archive: restore",
} as const;

const describe = (inventory: string) =>
  `People the user works with. Reads: query (empty lists everyone), get, timeline (meetings, mentions, owned tasks), relationships (edges between people)${inventory}, teams. ` +
  "Writes: upsert, link, archive (someone who left), merge (otherPersonId into personId), team_upsert, team_delete. " +
  "Write what you infer rather than read as status 'suggested' for the user to confirm.";

/** The `people` tool's description for the model. */
export const PEOPLE_TOOL_DESCRIPTION = describe("");

/**
 * Desktop adds the read-only `inventory` action (a scan of person and meeting notes
 * for migration, which reads files); mobile has no such action, so it never says so.
 */
export const PEOPLE_TOOL_DESCRIPTION_DESKTOP = describe(", inventory (scans existing person and meeting notes for migration; the user applies it)");
