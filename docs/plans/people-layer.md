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
   W2 as built (`feat/people-w2-capture`): parsers in `shared/people/parse.ts`
   (attendee values and lists, meeting dates, `Attendees:`/`When:` body lines,
   checklist owners, `foldName`); the resolver and `captureNoteMeeting` /
   `renderMeetingFrontmatter` in `electron/db/people-capture.ts` (exact match
   by Slack id, then email, then folded name/alias/persona title; ambiguous
   names become suggested attendees; unknown names become one stub per folded
   name, `stubPersonId`; a note's meeting is `noteMeetingId`); the file side in
   `electron/people-files.ts`. `attendees`/`date` are NOT Cairn-owned keys, so
   ordinary saves pass them through untouched; instead of `CAIRN_SHARED_KEYS`
   in `writeNoteFile`, the file watcher reads them back after external edits
   (`capturePeopleFromFile`) and a sync hook (`setAppliedRowsHook` in
   `desktop-sync.ts`, registered in `main.ts`) rewrites them in place when
   attendee rows arrive. W3/W5 call `refreshMeetingFrontmatter` after their own
   attendee writes. All of it is a no-op while the flag is off. The review
   items above are done: canonical `is_me` at read time (oldest wins),
   `app:reset`, note and project delete (`onNoteDeleted`), cross-workspace
   `mergeProject` (`detachForeignPeopleLinks`), and conflict copies drop
   `meeting_id`/`owner_person_id` (`stripCopyLinks`). Per-source attendance:
   `meeting_attendees.sources` (v67 desktop, v11 mobile, sync protocol 6) holds
   one claim `{on, at}` per source (`shared/people/claims.ts`), merged source
   by source so a removal survives sync; `source` is the strongest active one.
   In SQL read a claim with `json_extract(a.sources, '$.<source>.on') = 1`.
   `removeAttendeeSource` drops a person only when the last source lets go;
   use `attendeeIdsFromSource` instead of querying `source = ?`. Body-line and checklist
   capture passes (writing `note_action_items`) land with W4 indexing, which
   already owns the per-note reindex hook.
   W3 as built (`feat/people-w3-agent`, stacked on W2): the `people` tool
   (`query`, `get`, `timeline`, `relationships`, `upsert`, `link`; `inventory`
   is W9 and `prep` is W6) in `electron/mcp/tools/people.ts`, routed through the
   consolidated dispatcher so chat, coding and MCP share it; `attendees`/`date`
   on `ensure_note`/`update_notes` (source `declared`, person ids accepted) and
   `owner` on `create_task`/`update_tasks`. `toolSchemasFor({ people })` leaves
   the tool and arguments out while the flag is off, read once per session /
   MCP server start. Approval: `people` reads are READ per call
   (`riskForCall`, `PEOPLE_READ_ACTIONS`), writes are Cairn writes. Privacy:
   every read result passes `scrubAgentPrivate` (one place, the dispatcher), and
   `people.test.ts` walks every read tool. The prompt line became field
   descriptions on the new arguments, so prompts don't change with the flag.
   Not covered: a coding agent's `read`/`grep` on the .md file itself.
   Cost: about 880 tokens per request with the flag on.
   W4 as built (`feat/people-w4-indexing`):
   `electron/db/people-indexing.ts` (`indexNotePeople`) runs at the end of
   `computeAutoRelationships`, for the same notes (every live note on a full
   pass), and does nothing while the flag is off. Mentions: a `[[…]]` link to a
   persona note's title (alias/heading/folder forms too, folded match) adds a
   `wikilink` mention; wikilink mentions that left the body are removed, manual
   ones never. Action items: only owned checklist lines are indexed,
   `line_key` = `actionItemLineKey` (`shared/people/ids.ts`, box state left
   out so ticking keeps the key, `#2` for duplicate lines), owner resolved only
   on a single match, no stubs. Body lines: `captureNoteMeeting` with
   `body_line`/`convention`; a body date moves only a meeting the note made
   (never a calendar meeting); removing the lines removes their attendees, and
   stubs only a half-typed line made ("Ch" → "Chris") are tombstoned again. Body
   lines don't rewrite the frontmatter (the watcher would read them back as a
   second source). Graph: `GraphNodeType`/`GraphEdgeType` live in
   `shared/types/domain.ts` only (`shared/ui/graph.ts` re-exports), plus
   `GRAPH_NODE_TYPES`; `getKnowledgeGraph` adds confirmed people, meetings and
   `attended`, `mentions`, `meeting-note` (meeting → its notes, needed so a
   meeting links to anything), `reports-to` (report → manager), `mentor`,
   `partner`, `stakeholder` (`buddy_of` has no graph edge; ended edges are
   labelled "former"). A project filter keeps only meetings of scoped notes and
   people linked to shown nodes. The Knowledge Graph shows person/meeting
   filter chips once such nodes appear (`--node-person`, `--node-meeting`), and
   "Open" goes to the persona note / meeting note. Known gap: setting a
   person's persona note or creating a person doesn't re-index other notes
   until they're saved or a full recompute runs; W3/W5 can call
   `indexNotePeople` after those writes.
   After review: `indexNotesPeople` also runs from the file watcher (after
   `capturePeopleFromFile`) and the sync applied-rows hook, for notes edited
   outside the app (database rows only, never the file, so no echo). Body-line
   attendees are `suggested` (`captureNoteMeeting` takes `status` and
   `keepRemoved`), so they stay out of lists, the graph and the frontmatter
   until confirmed; someone the user removed isn't re-added while the line
   lists them (a tombstoned row whose `body_line` claim is still on; the claim
   goes off once the line drops them; `removeAttendeeSource` now records the
   dropped claim before tombstoning). Mentions: a persona title two people share
   links to neither, code fences and inline code are skipped, and a tombstoned
   mention is revived only if this pass released it (source `owner`, otherwise
   unused). Each note is indexed in its own try/catch.
   Second review round: body lines never create stub people (a stub per
   half-typed name churned synced rows); they match existing people only, and a
   note with no match doesn't become a meeting (so the stub-pruning pass is
   gone). The body-line form needs a bold label or a bullet and skips
   placeholders and groups (`tbd`, `none`, `users`, …). Date rule: a frontmatter
   `date` governs when the meeting has a frontmatter attendee claim; the body
   "When:" applies only otherwise, and never rewrites an unchanged meeting.
   Deleting a note tombstones the meeting it made (`nmt:`) with its last note;
   the unscoped graph hides note-made meetings with no live, unarchived note.
   Archiving does not tombstone (unarchiving would lose confirmed attendees).
   W9 as built (`claude/people-w9-migration-e448d5`): the tooling and tests for the
   migration gate. Not run on the pilot corpus (that needs Gerard's other
   machine). Pure heuristics in `shared/people/inventory.ts` (`guessPersona`,
   `guessMeeting`, `looksLikeName`, `nameFromTitle`, `firstName`; `isGroupName`
   and `withoutCode` moved into `parse.ts`, W4 imports them); `buildInventory` /
   `applyMigration` in `electron/db/people-migration.ts`; report and request
   types in `shared/types/people-migration.ts`. Surfaces: the `people` tool's
   read-only `inventory` action (compact: ids, names, confidence, action; no
   apply for agents), IPC `db:people:migration:inventory` / `db:people:migration:apply`
   (`dryRun`), and a "Find in notes" panel (`MigrationPanel`) opened from the
   People view's toolbar. A migration only ever happens from the panel/IPC with
   the user's ticks; no agent path writes it.
   - **Inventory** (read-only, works with the flag off): candidate persona
     notes (tag `person`/`people`/`persona`/`contact`/`colleague`/`teammate` or
     frontmatter `type`: +3; `People`/`Personas`/`Contacts`/… folder: +2;
     `Discussions/<Name>` folder named for a name-like title: +2; "Persona - "
     title prefix: +2; a 2–4 word capitalised title: +1 only next to another
     signal; high ≥ 4, medium 3, low 2, below 2 not listed), meeting notes
     (`attendees` frontmatter read from the files, `**Attendees:**`/`When:`
     body lines; code blocks, placeholders like "TBD"/"users", bare prose and a
     lone `date` don't count), owned checklist items by owner with how each
     owner resolves (`person`, `candidate` = a note that would become a person,
     `ambiguous`, `group` for "Team", `unknown`), ambiguous names (two candidate
     notes with one folded name, and short names two candidates share), and
     collisions with existing people (by persona link, email, or name). Archived
     notes are listed and skipped, deleted ones are not scanned, and only the
     asked workspace is read.
   - **Apply** takes `{ personas: [{ noteId, name?, aliases? }], meetings:
     [noteId] }` and re-derives everything from the database; nothing is
     trusted from an earlier inventory. Per persona: create a confirmed person
     (provenance `convention`, id `migratedPersonId` so two devices make one
     row, aliases from the title's nickname/frontmatter/accepted first names
     plus the persona title) or, when a person already matches, link the persona
     note to them (a stub is confirmed; a person with a different persona note,
     a dismissed one, an ambiguous name, an email/name conflict, or one the user
     deleted since is skipped with a reason). A first name ("Ana") is never
     guessed: the inventory suggests it as an alias when it fits exactly one
     candidate and the user ticks it; an alias another person already answers to
     is dropped. Then the W4 pass (`indexNotePeople`, body "Attendees:" pass
     left out) adds mentions and resolves action-item owners for the workspace's
     notes, and each approved meeting note goes through `captureNoteMeeting`
     (`frontmatter` source for an `attendees` property, `body_line` for the
     line, confirmed because the user approved it, `noStubs`: a name nobody
     matches stays text, an ambiguous one becomes suggested attendees listing
     both). Frontmatter `attendees`/`date` are written through
     `refreshMeetingFrontmatter` only for meeting notes with a confirmed
     attendee, after the database commit; persona notes, bodies and the
     "When:" line are never touched. Dry run runs the same code inside a
     transaction that is rolled back (and skips files), so the preview is exact.
     Flag off: `applied: false`, no writes.
   - **Tests**: `electron/test-support/people-corpus.ts` (synthetic, pilot
     shape: 15 persona notes incl. a nickname, an email alias, two same first
     names, two notes with one name, one archived, one deleted, one weak guess,
     existing people to collide with; 6 meetings with bold, bulleted and
     frontmatter attendee forms; 20 owned items in `**Name** -`, `[[Name]]:` and
     `@name` forms plus "Team"; prose, code-fence and journal look-alikes; a
     second workspace with the same names), `people-migration.test.ts`
     (inventory facts, flag-off no-op, dry run = real result and no write,
     idempotence by whole-table snapshots including `sync_pending`, no
     tombstones, notes unchanged, deleted/dismissed people stay, no cross-
     workspace link, per-timeline and open-item acceptance checks),
     `people-migration-files.test.ts` (real files), `shared/people/inventory.test.ts`.
   - **Runbook: running it on the real corpus** (the gate; not done yet).
     1. Back up first (copy the workspace folder and the database; the migration
        never deletes, but the frontmatter write touches meeting note files).
     2. Update to a build with this change, and open the work workspace. Turn
        on the People preview (Settings → Sidebar & views) so the view and the
        apply step are available; the flag alone doesn't change any data.
     3. People view → "Find in notes". Read the list before ticking: expect
        about 15 people and 6 meeting notes. Check that every persona note you
        know is listed with sensible confidence, that nothing else is ticked
        (a low guess is never ticked for you), that the two Sebastiens and
        Sebastian show as skipped or ambiguous, and that "Chris" (or any first
        name two people share) shows in the ambiguity line. For a skipped
        duplicate name (both "Sam Whitfield" notes), rename one of the notes,
        reopen Find in notes, and tick both; the panel has no rename control.
     4. Tick the first-name aliases you want ("Also answer to “Sebastien”" only
        where it points to one person), then Preview. The summary should show
        about the number of people you ticked, the meetings with attendees,
        and the action items assigned; names that match nobody are counted as
        staying text.
     5. Apply. Open three meeting notes and check the attendee strip and the
        `attendees`/`date` properties; open two persona notes and confirm the
        text is exactly as before; open a person page and compare their open
        items with the unchecked lines they own.
     6. Run Find in notes again: every persona you ticked now shows "Already a
        person" (greyed out; those rows can't be ticked again), and the ones
        you left unticked or that were skipped are unchanged. To replay the
        approvals, call `db:people:migration:apply` with the same list: it
        reports "unchanged" for everything already done and writes nothing.
     7. Volatile-text cleanup (phase 4) is not part of this tool: do it with the
        agent as normal note edits after the checks above.
   - **Acceptance criteria for the gate**: (a) inventory of the real corpus
     lists all 15 personas and 6 meetings with no persona missing and no wrong
     person ticked; (b) Preview and Apply agree; (c) after Apply, each of the
     meetings with N resolved attendees is on N people's timelines; (d) each
     person's open items match the unchecked lines they own; (e) a second
     Apply, and a second Find in notes, change nothing; (f) no persona note body
     differs (diff the notes folder, ignoring meeting note frontmatter); (g) the
     ambiguous names were settled by the user, not guessed; (h) with the flag
     off the workspace behaves as before. Anything failing goes back as a
     fixture in `people-corpus.ts` first.
   - **Not covered**: a person's Slack id, relationship type and cadence (set
     in the People view after migrating); nicknames only written in prose;
     one-word persona titles (a bare first name needs a tag or folder
     convention and a name-like title to be proposed); persona notes that live
     in several workspaces (each workspace is migrated on its own).
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
