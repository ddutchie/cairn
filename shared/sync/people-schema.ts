/**
 * People layer — DDL for the synced tables, shared by desktop
 * (`electron/db/schema.ts`, migration v66) and mobile (`mobile/src/db/schema.ts`
 * + its migration), so the column names and types can't drift between them.
 * Plan: docs/plans/people-layer.md.
 *
 * Like `attachments`, these tables have no foreign keys: the sync engine
 * replays rows in oplog order, not FK order, and deletes from peers arrive as
 * tombstones (`deleted_at`), which ON DELETE clauses never see. The query
 * modules keep the references tidy instead.
 *
 * Every JSON column holds text (arrays/objects serialised), as elsewhere in
 * the schema. Capture triggers are not here: desktop adds them in its
 * migration, mobile generates them from SYNCABLE_TABLES.
 */

/** The people tables the sync engine replicates, in FK-safe replay order. */
export const PEOPLE_SYNC_TABLES = [
  "people",
  "person_edges",
  "meetings",
  "meeting_attendees",
  "note_mentions",
] as const;

export const PEOPLE_SYNC_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS people (
  id              TEXT NOT NULL PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  aliases         TEXT NOT NULL DEFAULT '[]',
  emails          TEXT NOT NULL DEFAULT '[]',
  slack_id        TEXT,
  relationship    TEXT NOT NULL DEFAULT '[]',
  cadence         TEXT,
  persona_note_id TEXT,
  status          TEXT NOT NULL DEFAULT 'confirmed',
  provenance      TEXT NOT NULL DEFAULT 'explicit',
  stage           TEXT,
  title           TEXT,
  team            TEXT,
  location        TEXT,
  timezone        TEXT,
  is_me           INTEGER NOT NULL DEFAULT 0,
  agent_private   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  archived_at     TEXT,
  hlc             TEXT,
  deleted_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_people_ws ON people(workspace_id);
CREATE INDEX IF NOT EXISTS idx_people_persona ON people(persona_note_id);

CREATE TABLE IF NOT EXISTS person_edges (
  id             TEXT NOT NULL PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  type           TEXT NOT NULL,
  label          TEXT,
  ended_at       TEXT,
  status         TEXT NOT NULL DEFAULT 'confirmed',
  provenance     TEXT NOT NULL DEFAULT 'explicit',
  source_note_id TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  hlc            TEXT,
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_person_edges_source ON person_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_person_edges_target ON person_edges(target_id);

CREATE TABLE IF NOT EXISTS meetings (
  id           TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title        TEXT NOT NULL,
  starts_at    TEXT NOT NULL,
  ends_at      TEXT,
  source       TEXT NOT NULL DEFAULT 'manual',
  external_id  TEXT,
  series_key   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  hlc          TEXT,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_meetings_ws_start ON meetings(workspace_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_meetings_external ON meetings(workspace_id, external_id);

CREATE TABLE IF NOT EXISTS meeting_attendees (
  id         TEXT NOT NULL PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  person_id  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'confirmed',
  source     TEXT NOT NULL DEFAULT 'manual',
  sources    TEXT NOT NULL DEFAULT '{}',
  provenance TEXT NOT NULL DEFAULT 'explicit',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  hlc        TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_meeting_attendees_meeting ON meeting_attendees(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_attendees_person ON meeting_attendees(person_id);

CREATE TABLE IF NOT EXISTS note_mentions (
  id         TEXT NOT NULL PRIMARY KEY,
  note_id    TEXT NOT NULL,
  person_id  TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  hlc        TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_note_mentions_note ON note_mentions(note_id);
CREATE INDEX IF NOT EXISTS idx_note_mentions_person ON note_mentions(person_id);
`;

/**
 * Columns the people layer adds to existing synced tables. Older peers ignore
 * them (the engine writes only the columns both sides have), and a put from an
 * older peer leaves them untouched (it only updates the columns it carries).
 */
export const PEOPLE_ADDED_COLUMNS = [
  { table: "notes", column: "meeting_id", ddl: "meeting_id TEXT" },
  { table: "task_cards", column: "owner_person_id", ddl: "owner_person_id TEXT" },
  // Per-source claims on the person ({ source: { on, at } }, see
  // shared/people/claims.ts; `source` is the strongest active one). Merged per
  // source by the sync engine, so concurrent adds from two devices both
  // survive, a removal survives a sync, and a person leaves a meeting only when
  // the last source drops them. Added in v67, before any attendee row
  // existed outside development databases.
  { table: "meeting_attendees", column: "sources", ddl: "sources TEXT NOT NULL DEFAULT '{}'" },
  // Profile fields the user (or an autofill they confirmed) fills in. Additive
  // and optional, so no protocol bump: older peers ignore them and their puts
  // leave them untouched.
  { table: "people", column: "title", ddl: "title TEXT" },
  { table: "people", column: "team", ddl: "team TEXT" },
  { table: "people", column: "location", ddl: "location TEXT" },
  { table: "people", column: "timezone", ddl: "timezone TEXT" },
] as const;
