# People layer — integration plan

**Status:** In progress. W1 (schema release) implemented on
`feat/people-w1-schema` (2026-11-18). Ships as one launch (all PRD priorities
P0–P2), preceded by that invisible schema release.
**Sources:** PRD "People Management in Cairn" v2; "Playbook - Migrating Existing
Notes to the People Layer" (both Gerard Slee, 2026-11-18).
**Scope:** Data model, capture, UI, agent/MCP surface, 1:1 loop, sync, mobile and
migration, plus how it's built and released.

## Release shape

**Many PRs, two releases, one launch.**

1. **Schema release** (next desktop patch + next mobile build, nothing visible):
   the new tables, sync registration, `SYNC_PROTOCOL_VERSION` 4 → 5 and the
   `people` flag (off). Reason: the sync engine skips ops for entities it
   doesn't know (`shared/sync/engine.ts`, the `SYNCABLE_TABLES` guard in the
   apply loop). Peers re-read each other's whole oplog file on every tick, so a
   device that skipped people ops should apply them once it upgrades, unless
   the oplog was compacted in between. Mobile also generates capture triggers
   for every entry in `SYNCABLE_TABLES` at launch, so its tables must exist in
   the same build that lists them. Shipping the schema first means every device
   already knows the tables before the first row is written. The protocol bump
   gives the existing "device needs updating" hint, as it did for attachments.

   W1 as built: `shared/sync/people-schema.ts` (DDL shared by desktop and
   mobile, no foreign keys, as for `attachments`), desktop migration v66
   (+ capture triggers, local `person_profile_cache` and `note_action_items`),
   mobile migration v10, `shared/types/people.ts`, `electron/db/people-queries.ts`
   (+ tests), protocol 5, and the flag (`app_kv` key `feature.people`,
   `isPeopleEnabled`). Deletes are tombstones, like notes.

   After review (PR #312): rows that stand for a pair or an outside record get
   deterministic ids (`shared/people/ids.ts`: attendees, mentions, edges,
   calendar meetings), so concurrent adds on two devices converge on one row
   and re-adding revives the tombstone. `people.aliases`/`emails` union-merge
   like `tag_ids`. Deferred, with owners:
   - **Before launch (W2/W5):** `is_me` is only unique per device; two devices
     can each mark a different "me". Resolve at read time (one canonical me).
   - **W2:** `app:reset` (`electron/ipc/handlers.ts`), `deleteProject` /
     `mergeProject` and note delete don't know the new tables yet (dangling
     `persona_note_id`, mentions, `meeting_id` on moved notes). A note conflict
     copy clones `meeting_id`, so a meeting lists both; filter or strip it.
   - **Sync follow-up (any time, not tied to data):** `exportOplog` stamps
     forwarded ops with this device's protocol version, so a v4 device seen
     only through a v5 relay is never flagged "behind". Stamp only own ops.
2. **Launch** (desktop 3.3.0 + mobile minor): everything below, flag on.

Between the two, workstream PRs merge to `main` continuously behind the flag,
so `main` stays releasable and Gerard can use it on his own builds. There's no
feature-flag system today; the flag is one `app_kv` key read at startup, which
gates: the People view, the `people` tool and the new tool args (read at session
start, so the tool list still never changes mid-session), the capture passes,
and the Today prep and nudge items.

## What exists today, and what we reuse

| PRD need | Already in Cairn | Gap |
|---|---|---|
| Person as an entity | Nothing. People are notes; cards carry a free-text `assignee` | New `people` table + type + store slice |
| Persona note | Notes (`notes` table + `.md` file), wikilinks (`shared/notes/wikilinks.ts`) | A pointer from person → note, and back |
| Meetings | None as data. Today reads calendars through connectors (`electron/lib/today.ts`, `TodayEvent`) | A meeting entity with attendees |
| Meeting → person links | Wikilink + co-mention edges in `relationship_cache` (`electron/db/auto-relationships.ts`) | Typed attendee links, not title-guessing |
| Relationship graph | Knowledge graph (`GraphNodeType` = project/note/card/tag) | `person` node type, person-person edges |
| Action items | Checklist lines in notes; task cards with `assignee` | An index of owned checklist lines; card owner |
| Slack profile | MCP connectors (`electron/lib/external-tools.ts`) | Read-time lookup + local cache with staleness |
| Prep brief | Today automation (heartbeat runner, read-only toolset, brief files) | A per-person brief on the same runner |
| MCP tools | Consolidated toolset (`electron/mcp/tools/consolidated.ts`) | One `people` tool |
| Note frontmatter | Cairn writes its own keys; keeps other keys on disk only (`electron/host-shared/notes-io.ts`) | Two keys that sync and read back |
| Sync | `SYNCABLE_TABLES` (`shared/sync/schema.ts`) + capture triggers | New tables, protocol bump |

Cairn has **no calendar or Slack integration of its own**: every external feed
comes through connectors in an agent run, as Today does. So "auto-capture" means
whatever records a meeting (a Today run, an agent over MCP, the user) states the
attendees in a structured field, and Cairn links them deterministically from there.

## Decisions

1. **Workspace-level people**, project scoping only for views.
2. **Proposals are data, not chat cards.** Anything inferred lands as a row with
   `status = 'suggested'`, reviewed in the People view's tray (confirm, merge,
   dismiss; dismissed identities don't come back). Any surface can propose; only
   the user confirms. (`suggest_connections` is chat-only, so MCP agents couldn't
   use it, and a chat card disappears with the session.)
3. **Every structured fact carries provenance:** `explicit` (stated in text),
   `convention` (folder/tag/property pattern) or `inferred` (model judgment), plus
   the source note. Inferred facts always start as `suggested`.
4. **Edges stored one way, inverse derived.** `manager_of`, `mentor_of`,
   `buddy_of`, `stakeholder_of`, `partner` (symmetric); queries derive `reports_to`
   etc. "Former" is `ended_at` on the edge, not a separate type.
5. **Relationship-to-me is an open set:** known types (`direct_report`, `manager`,
   `peer`, `stakeholder`, `mentor`, `buddy`, `recruiter`, `candidate`) plus a free
   label. Multi-valued (Morel is stakeholder and mentor).
6. **Candidates are people** with a `stage` field.
7. **No group entities.** "Team" owners keep their owner text and stay unassigned.
8. **Meetings are their own entity** (option D from the review). With the prep
   brief and cadence nudges in the same launch, meetings must exist before any
   note does: Today's calendar events carry attendees, a 1:1 is "upcoming"
   before anyone writes minutes, and one meeting can have prep notes and minutes.
   A note is linked to at most one meeting.
9. **Meeting properties are mirrored into optional frontmatter** (`attendees`,
   `date`), Obsidian-compatible. The database is the source of truth.
10. **People view is hidden by default** and offered on first use.
11. **Persona notes are visible to agents by default**, with a per-person
    "Private from agents" switch enforced in the shared agent read path.
12. **Name matching is exact, never fuzzy:** slack id → email → name → alias →
    case/diacritic-folded name. Two candidates → a suggested link listing both.

## Data model

One migration in `electron/db/schema.ts` (shipped in the schema release); types
in `shared/types/people.ts`.

```sql
-- Syncable (added to SYNCABLE_TABLES, FK order after notes)
CREATE TABLE people (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  aliases         TEXT NOT NULL DEFAULT '[]',   -- JSON: "Seb", old names
  emails          TEXT NOT NULL DEFAULT '[]',   -- JSON: identity keys
  slack_id        TEXT,
  relationship    TEXT NOT NULL DEFAULT '[]',   -- JSON set of {type, label?, provenance}
  cadence         TEXT,                          -- weekly|biweekly|monthly
  persona_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed|suggested|dismissed
  provenance      TEXT NOT NULL DEFAULT 'explicit',   -- how the person was found
  stage           TEXT,                          -- candidates only
  is_me           INTEGER NOT NULL DEFAULT 0,    -- exactly one per workspace
  agent_private   INTEGER NOT NULL DEFAULT 0,    -- hide persona note from all agent reads
  created_at, updated_at, archived_at, hlc, deleted_at
);

CREATE TABLE person_edges (
  id, workspace_id,
  source_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  type      TEXT NOT NULL,       -- manager_of|mentor_of|buddy_of|stakeholder_of|partner
  label     TEXT,                -- "AA-in-MC trifecta"
  ended_at  TEXT,
  status    TEXT NOT NULL DEFAULT 'confirmed',
  provenance TEXT NOT NULL DEFAULT 'explicit',
  source_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
  created_at, updated_at, hlc, deleted_at
);

CREATE TABLE meetings (
  id, workspace_id,
  title       TEXT NOT NULL,
  starts_at   TEXT NOT NULL,
  ends_at     TEXT,
  source      TEXT NOT NULL,     -- calendar|note|manual
  external_id TEXT,              -- calendar event id, for dedupe across Today runs
  series_key  TEXT,              -- recurring series → cadence + "last 1:1"
  created_at, updated_at, hlc, deleted_at
);

CREATE TABLE meeting_attendees (
  id, meeting_id REFERENCES meetings(id) ON DELETE CASCADE,
  person_id  REFERENCES people(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'confirmed',  -- suggested when the match was ambiguous
  source     TEXT NOT NULL,      -- calendar|frontmatter|declared|body_line|manual
  provenance TEXT NOT NULL,
  created_at, hlc, deleted_at,
  UNIQUE (meeting_id, person_id)
);

-- Mentions of people in notes (not attendance)
CREATE TABLE note_mentions (
  id, note_id REFERENCES notes(id) ON DELETE CASCADE,
  person_id REFERENCES people(id) ON DELETE CASCADE,
  source TEXT NOT NULL,          -- wikilink|owner|manual
  created_at, hlc, deleted_at,
  UNIQUE (note_id, person_id)
);

ALTER TABLE notes      ADD COLUMN meeting_id      TEXT REFERENCES meetings(id) ON DELETE SET NULL;
ALTER TABLE task_cards ADD COLUMN owner_person_id TEXT REFERENCES people(id)   ON DELETE SET NULL;

-- Device-local, NOT synced
CREATE TABLE person_profile_cache (      -- read-time Slack fields + staleness
  person_id TEXT PRIMARY KEY, source TEXT NOT NULL,
  payload TEXT NOT NULL, fetched_at TEXT NOT NULL, error TEXT
);
CREATE TABLE note_action_items (         -- rebuilt from note bodies, like relationship_cache
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  line_key TEXT NOT NULL,                -- stable hash of the line text
  owner_text TEXT, owner_person_id TEXT, -- NULL for team owners / unresolved
  text TEXT NOT NULL, done INTEGER NOT NULL,
  PRIMARY KEY (note_id, line_key)
);
```

- **Volatile fields live only in the local cache.** Title, timezone, pronouns and
  status are never written to `people` or a persona note (the ZoomInfo lesson,
  enforced by the schema).
- **Action items live in the note; Cairn indexes them.** `- [ ] **Owner** - text`
  (and `[[Owner]]` / `@Owner` variants) is parsed into `note_action_items` on every
  save. "I owe" = owner is the `is_me` person; "they owe" = owner is them, both from
  one parse. Ticking an item on the person page rewrites the `[ ]` in the note.
  "Promote to task" makes a card with `owner_person_id` and a link back, for items
  that need a board, due date or blockers.
- **Graph:** `GraphNodeType` gains `"person" | "meeting"`; `GraphEdgeType` gains
  `"attended" | "mentions" | "reports-to" | "mentor" | "partner" | "stakeholder"`,
  computed in the same incremental pass as today's auto-relationships.

## Capture

**Resolver** (`electron/lib/people/resolve.ts`, pure parts in `shared/people/`):
`resolveAttendee({ name?, email?, slackId? }) → personId | suggestion`, per
decision 12. A miss creates a `suggested` stub with provenance (attended / owns
an item / mentioned). Mention-only stubs stay out of the main list until confirmed
or until they first attend a meeting.

**Ways a meeting gets attendees:**

1. **Calendar (Today).** `TodayEvent` gains `attendees`; the Today prompt asks for
   them in the calendar call it already makes. Each event upserts a meeting by
   `external_id`, with `series_key` for recurring ones. This is what powers
   "upcoming", the prep brief and cadence.
2. **Declared by an agent.** `ensure_note` / `update_notes` accept `attendees` and
   `date` (names, emails or person ids). The agent that read a transcript records
   the meeting in the same call it writes the note: Cairn creates or finds the
   meeting and links the note. The chat and coding prompts get one line saying so.
3. **Frontmatter** (below), for hand-written notes and Obsidian vaults.
4. **The attendee strip** in the app.

**Matching a note to a calendar meeting:** when a note's meeting and a calendar
meeting share a day and most attendees, Cairn suggests merging them (never
automatic). Notes written from a Today event's "Take notes" action link directly.

**Mentions:** `[[Persona note]]` in a note body adds a `note_mentions` row, in the
existing incremental pass. Mentions show on the timeline but aren't attendance.

### Meeting properties in frontmatter

Every Cairn note file already has frontmatter: Cairn's own keys
(`CAIRN_FRONTMATTER_KEYS`), plus keys the user or Obsidian added, which Cairn keeps
but **only on disk** (not in SQLite, not synced, not shown in the editor). So these
two keys get special treatment:

```yaml
---
id: …               # Cairn keys as today
title: Weekly sync with Chris and Sebastien
attendees:
  - "[[Chris Sponagle]]"
  - "[[Sebastien Morel]]"
date: 2026-11-11
---
```

- A new `CAIRN_SHARED_KEYS` set (`attendees`, `date`): `writeNoteFile` renders them
  from the note's meeting; the file watcher reads external edits back into the
  meeting. Emails and plain names are accepted on read; Cairn writes wikilinks,
  which is how Obsidian's Properties panel shows links.
- A note with `attendees` and no meeting gets one created (`source = note`).
  `date` counts as the meeting date only when `attendees` is present, so journal
  notes that use `date` aren't turned into meetings. `when` is a read alias.
- An Obsidian vault whose meeting notes already have an `attendees` property gets
  linked on import with no migration step.
- Nobody edits YAML inside Cairn: the attendee strip and date chip are the editor.
- Renaming a persona note re-renders its meetings' frontmatter through the
  existing wikilink-relink path.

## Surfaces

### People view (`ToggleableView` `"people"`)

Hidden by default, so non-users see no change to the sidebar or ⌘3–⌘9.
`hiddenViews` starts empty today (`src/store/slices/ui-layout.ts`), so this adds a
"hidden on first run" list for new views, applied once. Cairn offers to turn it on
(one dismissible hint) the first time a meeting gets attendees or a person is
created; Settings → Sidebar & views has the switch. Once on, it's numbered in
sidebar order like any other view. The data layer works whether it's on or off.

`src/components/people/PeopleView.tsx`, following `docs/design-language.md`:

- **List:** grouped by relationship (Direct reports, Manager, Peers, Stakeholders,
  Mentors, Candidates, Other). Each row: name, live title, local time, last met,
  next meeting, open items both ways, a lock if private from agents. Suggestions
  tray at the top when non-empty; filter and search.
- **Person page:** header (name, live fields with an "as of" marker when the cache
  is old or the fetch failed), relationship chips, edges ("Reports to Elisa",
  "Mentor: Sebastien (former)"), cadence and "last 1:1 N days ago". Then
  **Next meeting** with the Prep button, **Open items** (they owe / I owe),
  **Timeline** (meetings with their notes, mentions, cards; reverse-chronological,
  open items first) and **Persona** (the persona note inline, editable).
- **Settings on the page:** relationship, cadence, aliases/emails, private from
  agents, candidate stage.
- Entry points: person chips anywhere (attendee strip, card owner, action items),
  the command palette, `[[Name]]` hover cards.

### Meeting-note header

A note linked to a meeting shows the attendee strip and date chip above the body
(click a person → their page, `+` to add, ambiguous matches shown as suggestions).
"Add attendees" in the note menu and the meeting template make a note a meeting.

### Cards

Owner picker (Combobox over people) next to the existing assignee. A one-shot
"match assignees to people" action fills `owner_person_id` where the text matches.

### Graph and Insights

Knowledge Graph: person and meeting node filters. Insights gets a relationship
canvas and an org chart (from `manager_of` edges), following the analytics-canvas
pattern (`useScopedData`, `useFontScale`, `useContainerDims`).

### 1:1 loop

- **Prep brief** on the Today runner: a `prep` automation kind with the read-only
  toolset plus connectors, given Cairn's facts for one person (last meeting and
  its notes, open items both ways, the persona's current-focus section) and asked
  for what they've recently posted about. Saved like Today briefs
  (`out/prep/<personId>/<date>.json`). Runs from the Prep button, and automatically
  ahead of a calendar meeting whose attendees include a person with a cadence.
  It describes what someone worked on, never activity counts or online time.
- **Cadence nudges** as Today items: "No 1:1 with X in 3 weeks", from `series_key`
  and the person's cadence.
- **Slack profile by reference** (`electron/lib/people/profile.ts`): on page open,
  if the cache is older than 24h, call the user's Slack connector through the
  existing external-tools path; render cache first, refresh in the background,
  keep the last value marked stale on failure. With no Slack connector the fields
  are simply absent.

## Agent and MCP surface

- **One new tool `people`** in `TOOL_SCHEMAS`, with `action`: `query` (by
  relationship, name, edge; "who owns X" via persona search), `get`, `timeline`,
  `relationships`, `upsert`, `link` (edge, attendee, mention), `inventory`
  (read-only migration manifest), `prep`. `upsert` and `link` take `status` and
  `provenance`; anything an agent infers goes in as `suggested`.
- `ensure_note` / `update_notes` gain `attendees` + `date`; `create_task` /
  `update_tasks` gain `owner`.
- Approval: `upsert`/`link` are writes (`tool-risk.ts`,
  `RELATIONSHIP_AFFECTING_TOOLS`); reads are free.
- Tool checklist: `humanize-tool`, coding-session and chat prompts, the mobile
  toolset, IPC mock parity, site `_tools.json`, and a re-run of
  `electron/lib/tool-schema-optimization.test.ts`; measure the budget with
  `scratch/measure-tools.ts`.
- **Private from agents:** a private person's persona note is left out of every
  agent read path (keyword and semantic search, `get_item`, graph reads,
  `people.get`/`timeline`, the prep brief), on MCP and in chat. The filter sits in
  one place the read tools share (`electron/mcp/tools/sql-reads.ts` and the
  consolidated dispatcher), with a test that walks every read tool.

## Mobile

The schema arrives in the schema release. At launch: People list, person page
(open items, timeline, persona), attendee strip on meeting notes, ticking action
items, and editing a person's relationship and cadence. The prep brief and Slack
lookup stay desktop-only (they need connectors). The mobile toolset gets the same
`people` tool and args, tested in `mobile/src/chat/tools.test.ts`.

## Migrating existing person notes

The Nov 18 work-workspace corpus (15 personas, 6 meetings, ~20 action items) is the
pilot and a launch gate.

| Playbook phase | Mechanism |
|---|---|
| 0 Inventory | `people.inventory`: notes tagged `person`, `Discussions/<Name>` folders, notes with `attendees` frontmatter or `**Attendees:**`/`**When:**` body lines, checklist owners. Counts + candidates, writes nothing |
| 1 Person entities | Agent calls `people.upsert` (`suggested`, provenance per fact; Slack IDs from the Nov 18 dig). User confirms in the tray (~15 confirmations) |
| 2 Meeting backlinking | Body `**Attendees:**`/`**When:**` lines become suggested meetings with attendees; confirming one links the note and writes the frontmatter. The body line stays. Ambiguous names (Sebastien × 2, Sebastian) come out as suggestions listing both |
| 3 Action items | Nothing to do: the `note_action_items` index. Team owners stay unassigned |
| 4 Volatile cleanup | Agent proposes an edit per persona note (normal note-edit approval), marking copied title/timezone/pronoun blocks as historical, never deleting |
| 5 Verification | The tests below on a synthetic fixture, then a manual pass on the real corpus |

Acceptance tests (synthetic fixture with the same shape; no real colleague names
in the repo):

- The combined-sync meeting appears on both attendees' timelines.
- A meeting with N resolved attendees appears on N timelines, from each capture path.
- A person's open items equal the unchecked lines they own, across notes.
- A person with two relationship types shows both.
- Re-running inventory + upsert on a migrated workspace changes nothing.
- Frontmatter round-trip: Cairn writes it, an external edit reads back, Obsidian-style values parse.
- After cleanup, no persona note body has a copied title outside a "historical" block.
- A private person's persona note is absent from every agent read tool.

## Workstreams and build order

Each workstream is one or more PRs into `main`, behind the flag. W1 blocks the
rest; after it, the others can run in parallel (W5 and W8 consume W2–W4 data but
can start against fixtures).

| # | Workstream | Depends on | Contents |
|---|---|---|---|
| W1 | Foundations (schema release) | — | Migration, `shared/types/people.ts`, `people-queries.ts` + tests (inverse edges, relationship queries), sync tables + protocol bump, the flag. Ships alone first |
| W2 | Capture core | W1 | Resolver, `shared/people/` parsers (frontmatter values, body lines, checklist owners, name folding), `CAIRN_SHARED_KEYS` write/read-back, note ↔ meeting linking |
| W3 | Agent surface | W1, W2 | `people` tool, note/task tool args, privacy filter + every-read-tool test, prompts, tool checklist |
| W4 | Indexing | W1 | Mention and action-item passes, graph node/edge types |
| W5 | People UI | W1 (+W2/W4 data) | View + hidden-by-default + hint, tray, person page, attendee strip, card owner, convert note to person, IPC + store slice + mocks |
| W6 | 1:1 loop | W1, W3 | Today attendees + meeting upsert, prep automation kind, cadence nudges, Slack profile cache |
| W7 | Insights | W4 | Relationship canvas, org chart |
| W8 | Mobile | W1 (+W2/W4) | Mobile schema, People screens, toolset |
| W9 | Migration gate | W2–W5 | `inventory`, fixture tests, pilot corpus run |

## Launch checklist

- Schema release out on desktop and mobile, and verified on Gerard's devices
  before any launch PR writes data with the flag on.
- Verify how a peer that skipped unknown-entity ops catches up after upgrading.
- Pilot corpus migrated; all acceptance tests green.
- `changelogs/v3.3.0.md` and the mobile changelog for its next minor (no version
  bumps by hand; the release scripts do that).
- `scripts/features.config.js` entry for the People layer (+ condense 3.2.x cards).
- Site sync: new tool in `_tools.json`, People in `_views.json` (it's hidden by
  default, so the shortcut table must say so), screenshots.
- Flag removed (or defaulted on) in the launch release.

## Risks

| Risk | Mitigation |
|---|---|
| Older devices drop people ops | Schema release first; protocol bump surfaces "device needs updating" |
| Wrong person linked ("Chris" × 2) | Exact matching only; ambiguity becomes a suggestion |
| Auto-capture depends on agents passing attendees | Calendar path + frontmatter + mention pass as safety nets; attendee strip makes gaps visible |
| Duplicate meetings (calendar + note) | Suggested merge on same day + attendee overlap |
| Big-bang launch hides problems until late | Flagged merges to `main`; daily use on Gerard's builds; pilot corpus as gate |
| Tool budget creep | One `people` tool; measured before merge |
| Profile fetch slows the page | Cache first, background refresh |
| Surveillance feel | Prep describes topics, never activity counts; no metrics on the person page |
| Persona exposure to agents | Per-person private flag, enforced in one shared read path |
