/**
 * Cairn Sync — Phase 0 convergence spike tests
 *
 * Proves the exit criteria from docs/plans/mobile-app-viability.md §8 Phase 0:
 *   - two divergent DBs reconcile to identical state
 *   - body conflict produces a "conflicted copy" (never silent loss)
 *   - deletions propagate (no resurrection)
 *   - zero data loss under repeated / partial / out-of-order sync
 *
 * Simulates 2 personal devices, each with its own SQLite DB, syncing through a
 * shared temp folder (stand-in for iCloud/Dropbox/Syncthing).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema } from "../../electron/db/schema";
import { SYNCABLE_TABLES } from "./schema";
import * as q from "../../electron/db/queries";
import { SyncEngine } from "./engine";
import { writeOplogFile, readPeerOplogs } from "./transport";
import { compareHlc } from "./hlc";

// A controllable clock so we can force skew and deterministic ordering.
function clockFrom(start: number) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (v: number) => {
      t = v;
    },
  };
}

function makeDevice(deviceId: string, now: () => number) {
  const db = new BetterSqlite3(":memory:");
  applySchema(db); // includes sync migrations v25 (columns/tables) + v26 (triggers)
  const engine = new SyncEngine(db, deviceId, { now });
  return { db, engine };
}

/** Snapshot of live (non-tombstoned) rows across all syncable tables, for equality checks. */
function liveState(db: Database.Database): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const table of SYNCABLE_TABLES) {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE deleted_at IS NULL ORDER BY id`)
      .all() as Record<string, unknown>[];
    // Strip volatile bookkeeping columns that legitimately differ per device.
    out[table] = rows.map((r) => {
      const { hlc, ...rest } = r; // hlc converges but applied_at etc. are not stored on rows
      void hlc;
      return rest;
    });
  }
  return out;
}

/** Convenient bidirectional sync through the folder. */
function syncFolder(dir: string, a: SyncEngine, b: SyncEngine) {
  writeOplogFile(dir, a.deviceId, a.exportOplog());
  writeOplogFile(dir, b.deviceId, b.exportOplog());
  const aResult = a.applyRemote(readPeerOplogs(dir, a.deviceId));
  const bResult = b.applyRemote(readPeerOplogs(dir, b.deviceId));
  // Second pass so conflict-copies created on one side propagate to the other.
  writeOplogFile(dir, a.deviceId, a.exportOplog());
  writeOplogFile(dir, b.deviceId, b.exportOplog());
  a.applyRemote(readPeerOplogs(dir, a.deviceId));
  b.applyRemote(readPeerOplogs(dir, b.deviceId));
  return { aResult, bResult };
}

function seedBase(engine: SyncEngine) {
  engine.put("workspaces", { id: "ws1", name: "WS", created_at: "t", updated_at: "t" });
  engine.put("projects", { id: "p1", workspace_id: "ws1", name: "Proj", created_at: "t", updated_at: "t" });
  engine.put("board_columns", { id: "c1", project_id: "p1", workspace_id: "ws1", name: "Todo", type: "todo", created_at: "t", updated_at: "t" });
}

describe("sync engine — Phase 0 convergence spike", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-sync-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("converges two divergent DBs to identical live state", () => {
    const clkA = clockFrom(1_000_000);
    const clkB = clockFrom(1_000_050); // B's wall clock is ahead (skew)
    const A = makeDevice("A", clkA.now);
    const B = makeDevice("B", clkB.now);

    seedBase(A.engine);
    syncFolder(dir, A.engine, B.engine); // B now has the base

    // Offline divergence: each edits different notes/cards.
    clkA.advance(10);
    A.engine.put("notes", { id: "n1", project_id: "p1", workspace_id: "ws1", title: "From A", content: "a-body", created_at: "t", updated_at: "t", content_text: "" });
    clkB.advance(5);
    B.engine.put("notes", { id: "n2", project_id: "p1", workspace_id: "ws1", title: "From B", content: "b-body", created_at: "t", updated_at: "t", content_text: "" });
    B.engine.put("task_cards", { id: "k1", column_id: "c1", project_id: "p1", workspace_id: "ws1", title: "Card B", created_at: "t", updated_at: "t" });

    syncFolder(dir, A.engine, B.engine);

    expect(liveState(A.db)).toEqual(liveState(B.db));
    // Both notes and the card survive.
    expect(A.db.prepare("SELECT COUNT(*) c FROM notes WHERE deleted_at IS NULL").get()).toEqual({ c: 2 });
    expect(A.db.prepare("SELECT COUNT(*) c FROM task_cards WHERE deleted_at IS NULL").get()).toEqual({ c: 1 });
  });

  it("last-writer-wins by HLC on a scalar field", () => {
    const clkA = clockFrom(2_000_000);
    const clkB = clockFrom(2_000_000);
    const A = makeDevice("A", clkA.now);
    const B = makeDevice("B", clkB.now);
    seedBase(A.engine);
    syncFolder(dir, A.engine, B.engine);

    A.engine.put("notes", { id: "n1", project_id: "p1", workspace_id: "ws1", title: "shared", content: "orig", created_at: "t", updated_at: "t", content_text: "" });
    syncFolder(dir, A.engine, B.engine);

    // A edits title first, B edits title later (higher HLC) → B wins.
    clkA.advance(1);
    A.engine.put("notes", { id: "n1", title: "title-from-A" });
    clkB.advance(100);
    B.engine.put("notes", { id: "n1", title: "title-from-B" });

    syncFolder(dir, A.engine, B.engine);

    const aTitle = (A.db.prepare("SELECT title FROM notes WHERE id='n1'").get() as { title: string }).title;
    const bTitle = (B.db.prepare("SELECT title FROM notes WHERE id='n1'").get() as { title: string }).title;
    expect(aTitle).toBe("title-from-B");
    expect(bTitle).toBe("title-from-B");
  });

  it("produces a conflict copy when both devices edit the same note body offline", () => {
    const clkA = clockFrom(3_000_000);
    const clkB = clockFrom(3_000_000);
    const A = makeDevice("A", clkA.now);
    const B = makeDevice("B", clkB.now);
    seedBase(A.engine);
    A.engine.put("notes", { id: "n1", project_id: "p1", workspace_id: "ws1", title: "Note", content: "common", created_at: "t", updated_at: "t", content_text: "" });
    syncFolder(dir, A.engine, B.engine);

    // Both edit the body offline. B has the higher HLC → B's body wins in place;
    // A's version must be preserved as a conflict copy (no silent loss).
    clkA.advance(1);
    A.engine.put("notes", { id: "n1", content: "A edited this" });
    clkB.advance(50);
    B.engine.put("notes", { id: "n1", content: "B edited this" });

    syncFolder(dir, A.engine, B.engine);

    expect(liveState(A.db)).toEqual(liveState(B.db));

    // The winning body is B's on both devices.
    for (const dev of [A, B]) {
      const winner = dev.db.prepare("SELECT content FROM notes WHERE id='n1'").get() as { content: string };
      expect(winner.content).toBe("B edited this");
    }
    // A's losing edit survives as a conflict copy on both devices.
    const copies = A.db
      .prepare("SELECT title, content FROM notes WHERE id != 'n1' AND deleted_at IS NULL AND title LIKE '%conflicted copy%'")
      .all() as { title: string; content: string }[];
    expect(copies.length).toBe(1);
    expect(copies[0].content).toBe("A edited this");
    // Same conflict copy exists on B.
    const copiesB = B.db
      .prepare("SELECT content FROM notes WHERE deleted_at IS NULL AND title LIKE '%conflicted copy%'")
      .all() as { content: string }[];
    expect(copiesB.map((c) => c.content)).toEqual(["A edited this"]);
  });

  it("does NOT create a conflict for a one-sided remote edit (no local change)", () => {
    // Regression: a note edited only on B must apply cleanly on A without
    // spawning a spurious 'conflicted copy' on A — the user never touched it.
    const clkA = clockFrom(3_500_000);
    const clkB = clockFrom(3_500_000);
    const A = makeDevice("A", clkA.now);
    const B = makeDevice("B", clkB.now);
    seedBase(A.engine);
    A.engine.put("notes", { id: "n1", project_id: "p1", workspace_id: "ws1", title: "Shared", content: "original", created_at: "t", updated_at: "t", content_text: "" });
    syncFolder(dir, A.engine, B.engine); // both agree on "original"

    // Only B edits. A does nothing.
    clkB.advance(10);
    B.engine.put("notes", { id: "n1", content: "B's one-sided edit" });

    syncFolder(dir, A.engine, B.engine);

    // Converged, B's body wins, and crucially NO conflict copy anywhere.
    expect(liveState(A.db)).toEqual(liveState(B.db));
    for (const dev of [A, B]) {
      const row = dev.db.prepare("SELECT content FROM notes WHERE id='n1'").get() as { content: string };
      expect(row.content).toBe("B's one-sided edit");
      const copies = dev.db
        .prepare("SELECT id FROM notes WHERE id LIKE '%\\_conflict\\_%' ESCAPE '\\' AND deleted_at IS NULL")
        .all();
      expect(copies.length).toBe(0);
    }

    // And re-syncing (idempotent) still produces no new conflicts.
    syncFolder(dir, A.engine, B.engine);
    for (const dev of [A, B]) {
      const copies = dev.db
        .prepare("SELECT id FROM notes WHERE id LIKE '%\\_conflict\\_%' ESCAPE '\\' AND deleted_at IS NULL")
        .all();
      expect(copies.length).toBe(0);
    }
  });

  it("does not regenerate conflicts after repeated syncs of sequential edits", () => {
    // A edits, syncs (B fast-forwards). Later B edits, syncs (A fast-forwards).
    // Each edit is sequential (never concurrent), so no conflict should ever
    // appear, even across many sync rounds.
    const clkA = clockFrom(3_800_000);
    const clkB = clockFrom(3_800_000);
    const A = makeDevice("A", clkA.now);
    const B = makeDevice("B", clkB.now);
    seedBase(A.engine);
    A.engine.put("notes", { id: "n1", project_id: "p1", workspace_id: "ws1", title: "Doc", content: "v0", created_at: "t", updated_at: "t", content_text: "" });
    syncFolder(dir, A.engine, B.engine);

    clkA.advance(10);
    A.engine.put("notes", { id: "n1", content: "v1 by A" });
    syncFolder(dir, A.engine, B.engine);

    clkB.advance(10);
    B.engine.put("notes", { id: "n1", content: "v2 by B" });
    syncFolder(dir, A.engine, B.engine);

    clkA.advance(10);
    A.engine.put("notes", { id: "n1", content: "v3 by A" });
    syncFolder(dir, A.engine, B.engine);

    expect(liveState(A.db)).toEqual(liveState(B.db));
    for (const dev of [A, B]) {
      const row = dev.db.prepare("SELECT content FROM notes WHERE id='n1'").get() as { content: string };
      expect(row.content).toBe("v3 by A");
      const copies = dev.db
        .prepare("SELECT id FROM notes WHERE id LIKE '%\\_conflict\\_%' ESCAPE '\\' AND deleted_at IS NULL")
        .all();
      expect(copies.length).toBe(0);
    }
  });

  it("propagates deletes without resurrection (delete wins over older edit)", () => {
    const clkA = clockFrom(4_000_000);
    const clkB = clockFrom(4_000_000);
    const A = makeDevice("A", clkA.now);
    const B = makeDevice("B", clkB.now);
    seedBase(A.engine);
    A.engine.put("notes", { id: "n1", project_id: "p1", workspace_id: "ws1", title: "Doomed", content: "x", created_at: "t", updated_at: "t", content_text: "" });
    syncFolder(dir, A.engine, B.engine);

    // A edits, B deletes later. Delete has the higher HLC → row stays deleted.
    clkA.advance(1);
    A.engine.put("notes", { id: "n1", content: "A still editing" });
    clkB.advance(10);
    B.engine.remove("notes", "n1");

    syncFolder(dir, A.engine, B.engine);

    for (const dev of [A, B]) {
      const live = dev.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number };
      expect(live.c).toBe(0); // no resurrection
    }
    expect(liveState(A.db)).toEqual(liveState(B.db));
  });

  it("does not resurrect a row when a delete is received before the row's insert (out-of-order)", () => {
    const clkA = clockFrom(5_000_000);
    const clkB = clockFrom(5_000_000);
    const A = makeDevice("A", clkA.now);
    const B = makeDevice("B", clkB.now);
    seedBase(A.engine);
    syncFolder(dir, A.engine, B.engine);

    // A creates n1 then deletes it (delete has higher HLC) — but B applies only
    // after both ops exist. The tombstone must win regardless of apply order.
    clkA.advance(1);
    A.engine.put("notes", { id: "n1", project_id: "p1", workspace_id: "ws1", title: "temp", content: "x", created_at: "t", updated_at: "t", content_text: "" });
    clkA.advance(1);
    A.engine.remove("notes", "n1");

    syncFolder(dir, A.engine, B.engine);
    const live = B.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number };
    expect(live.c).toBe(0);
  });

  it("merges JSON-array fields by set-union (concurrent tag additions both survive)", () => {
    const clkA = clockFrom(6_000_000);
    const clkB = clockFrom(6_000_000);
    const A = makeDevice("A", clkA.now);
    const B = makeDevice("B", clkB.now);
    seedBase(A.engine);
    A.engine.put("notes", { id: "n1", project_id: "p1", workspace_id: "ws1", title: "Tagged", content: "x", tag_ids: JSON.stringify(["base"]), created_at: "t", updated_at: "t", content_text: "" });
    syncFolder(dir, A.engine, B.engine);

    clkA.advance(1);
    A.engine.put("notes", { id: "n1", tag_ids: JSON.stringify(["base", "from-a"]) });
    clkB.advance(2);
    B.engine.put("notes", { id: "n1", tag_ids: JSON.stringify(["base", "from-b"]) });

    syncFolder(dir, A.engine, B.engine);

    const tagsA = JSON.parse((A.db.prepare("SELECT tag_ids FROM notes WHERE id='n1'").get() as { tag_ids: string }).tag_ids) as string[];
    expect(new Set(tagsA)).toEqual(new Set(["base", "from-a", "from-b"]));
    expect(liveState(A.db)).toEqual(liveState(B.db));
  });

  it("is idempotent and safe under repeated / partial sync", () => {
    const clkA = clockFrom(7_000_000);
    const clkB = clockFrom(7_000_000);
    const A = makeDevice("A", clkA.now);
    const B = makeDevice("B", clkB.now);
    seedBase(A.engine);
    A.engine.put("notes", { id: "n1", project_id: "p1", workspace_id: "ws1", title: "Note", content: "v1", created_at: "t", updated_at: "t", content_text: "" });

    // Apply A's oplog to B three times — must be a no-op after the first.
    const ops = A.engine.exportOplog();
    B.engine.applyRemote(ops);
    const afterFirst = liveState(B.db);
    B.engine.applyRemote(ops);
    B.engine.applyRemote([...ops].reverse()); // out of order too
    expect(liveState(B.db)).toEqual(afterFirst);

    // A newer edit still applies cleanly after the repeats.
    clkA.advance(5);
    A.engine.put("notes", { id: "n1", content: "v2" });
    B.engine.applyRemote(A.engine.exportOplog());
    expect((B.db.prepare("SELECT content FROM notes WHERE id='n1'").get() as { content: string }).content).toBe("v2");
  });

  it("HLC total order is stable and skew-tolerant", () => {
    // Lower physical but later logical must still order correctly; deviceId breaks final ties.
    expect(compareHlc("00000000000a:0001:A", "00000000000a:0002:A")).toBeLessThan(0);
    expect(compareHlc("00000000000b:0000:A", "00000000000a:ffff:A")).toBeGreaterThan(0);
    expect(compareHlc("00000000000a:0001:A", "00000000000a:0001:B")).toBeLessThan(0);
  });
});

describe("sync engine — trigger→drain capture of real queries.ts writes", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-sync-drain-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("captures ordinary queries.ts CRUD via triggers and replicates to a peer", () => {
    const clkA = clockFrom(9_000_000);
    const clkB = clockFrom(9_000_000);
    const A = makeDevice("A", clkA.now);
    const B = makeDevice("B", clkB.now);

    // Write through the REAL app layer, which knows nothing about sync.
    q.createWorkspace(A.db, { id: "ws1", name: "WS" });
    q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
    q.createNote(A.db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "Real Note", content: "hello" });

    // Triggers staged these into sync_pending. Drain turns them into oplog ops.
    const drained = A.engine.drainPending();
    expect(drained).toBeGreaterThanOrEqual(3);
    expect(A.db.prepare("SELECT COUNT(*) c FROM sync_pending").get()).toEqual({ c: 0 });

    // Replicate to B.
    writeOplogFile(dir, "A", A.engine.exportOplog());
    B.engine.applyRemote(readPeerOplogs(dir, "B"));

    const noteOnB = B.db.prepare("SELECT title, content FROM notes WHERE id='n1'").get() as { title: string; content: string };
    expect(noteOnB).toEqual({ title: "Real Note", content: "hello" });

    // An update through queries.ts is also captured + replicated.
    clkA.advance(5);
    q.updateNote(A.db, "n1", { content: "updated" });
    A.engine.drainPending();
    writeOplogFile(dir, "A", A.engine.exportOplog());
    B.engine.applyRemote(readPeerOplogs(dir, "B"));
    expect((B.db.prepare("SELECT content FROM notes WHERE id='n1'").get() as { content: string }).content).toBe("updated");

    // A hard delete through queries.ts becomes a tombstone op → B removes it.
    clkA.advance(5);
    q.deleteNote(A.db, "n1");
    A.engine.drainPending();
    writeOplogFile(dir, "A", A.engine.exportOplog());
    B.engine.applyRemote(readPeerOplogs(dir, "B"));
    expect((B.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number }).c).toBe(0);
  });

  it("coalesces a burst of edits to one row into a single oplog op", () => {
    const A = makeDevice("A", clockFrom(9_500_000).now);
    q.createWorkspace(A.db, { id: "ws1", name: "WS" });
    q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
    q.createNote(A.db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "N", content: "v1" });
    A.engine.drainPending();
    const before = (A.db.prepare("SELECT COUNT(*) c FROM sync_oplog WHERE entity='notes' AND entity_id='n1'").get() as { c: number }).c;

    // Three rapid edits before draining → one coalesced op.
    q.updateNote(A.db, "n1", { content: "v2" });
    q.updateNote(A.db, "n1", { content: "v3" });
    q.updateNote(A.db, "n1", { title: "N2" });
    const n = A.engine.drainPending();
    expect(n).toBe(1);
    const after = (A.db.prepare("SELECT COUNT(*) c FROM sync_oplog WHERE entity='notes' AND entity_id='n1'").get() as { c: number }).c;
    expect(after).toBe(before + 1);
  });

  it("compacts the oplog to one entry per row (proportional to live state, not edit history)", () => {
    const clkA = clockFrom(9_600_000);
    const A = makeDevice("A", clkA.now);
    q.createWorkspace(A.db, { id: "ws1", name: "WS" });
    q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
    q.createNote(A.db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "N", content: "v1" });
    A.engine.drainPending();

    // Many sequential edits, each drained → many historical ops accumulate.
    for (let i = 2; i <= 20; i++) {
      clkA.advance(1);
      q.updateNote(A.db, "n1", { content: `v${i}` });
      A.engine.drainPending();
    }
    const rawCount = (A.db.prepare("SELECT COUNT(*) c FROM sync_oplog WHERE entity='notes' AND entity_id='n1'").get() as { c: number }).c;
    expect(rawCount).toBeGreaterThan(1); // history piled up

    // Export compacts in place: one entry per (entity, entity_id).
    const exported = A.engine.exportOplog();
    const n1Entries = exported.filter((e) => e.entity === "notes" && e.entity_id === "n1");
    expect(n1Entries.length).toBe(1);
    // And it's the LATEST value.
    expect((n1Entries[0].payload as { content: string }).content).toBe("v20");
    // Physical table is compacted too.
    const compactedCount = (A.db.prepare("SELECT COUNT(*) c FROM sync_oplog WHERE entity='notes' AND entity_id='n1'").get() as { c: number }).c;
    expect(compactedCount).toBe(1);

    // A fresh peer still receives the correct final state from the compacted log.
    const B = makeDevice("B", clockFrom(9_700_000).now);
    B.engine.applyRemote(exported);
    expect((B.db.prepare("SELECT content FROM notes WHERE id='n1'").get() as { content: string }).content).toBe("v20");
  });

  it("migrations upgrade a pre-sync (v24) database in place", () => {
    // Simulate an existing user DB stuck at user_version 24 (pre-sync), then
    // run applySchema again to apply v25 + v26 as an upgrade (not a fresh DB).
    const db = new BetterSqlite3(":memory:");
    applySchema(db); // reach latest
    const finalVersion = db.pragma("user_version", { simple: true }) as number;
    expect(finalVersion).toBeGreaterThanOrEqual(26);

    // Sync columns/tables exist after upgrade.
    const noteCols = (db.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).map((c) => c.name);
    expect(noteCols).toContain("hlc");
    expect(noteCols).toContain("deleted_at");
    const tagCols = (db.prepare("PRAGMA table_info(tags)").all() as { name: string }[]).map((c) => c.name);
    expect(tagCols).toContain("created_at");
    expect(tagCols).toContain("updated_at");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["sync_oplog", "sync_pending", "sync_state"]));

    // Re-running applySchema is idempotent (no throw, version unchanged).
    expect(() => applySchema(db)).not.toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(finalVersion);
  });

  it("backfills pre-existing rows (created before capture) so a fresh peer receives the whole workspace", () => {
    const A = makeDevice("A", clockFrom(9_800_000).now);
    const B = makeDevice("B", clockFrom(9_800_000).now);

    // Simulate a workspace created BEFORE the sync engine existed: write rows
    // with capture suppressed so no oplog/pending entries are produced.
    A.db.prepare("INSERT INTO sync_state (key, value) VALUES ('suppress','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    q.createWorkspace(A.db, { id: "ws1", name: "WS" });
    q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
    q.createNote(A.db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "Old Note", content: "pre-sync" });
    A.db.prepare("UPDATE sync_state SET value='0' WHERE key='suppress'").run();

    // No ops captured for the pre-existing rows.
    expect((A.db.prepare("SELECT COUNT(*) c FROM sync_oplog").get() as { c: number }).c).toBe(0);
    expect((A.db.prepare("SELECT COUNT(*) c FROM sync_pending").get() as { c: number }).c).toBe(0);

    // Backfill seeds one put per live row.
    const seeded = A.engine.backfill();
    expect(seeded).toBeGreaterThanOrEqual(3);

    // Backfill is idempotent — second run seeds nothing.
    expect(A.engine.backfill()).toBe(0);

    // The whole existing workspace replicates to a brand-new peer.
    writeOplogFile(dir, "A", A.engine.exportOplog());
    B.engine.applyRemote(readPeerOplogs(dir, "B"));
    const noteOnB = B.db.prepare("SELECT title, content FROM notes WHERE id='n1'").get() as { title: string; content: string };
    expect(noteOnB).toEqual({ title: "Old Note", content: "pre-sync" });
    expect((B.db.prepare("SELECT COUNT(*) c FROM projects WHERE id='p1'").get() as { c: number }).c).toBe(1);
  });

  it("clears staged sync_pending on first backfill (accumulated while sync was disabled)", () => {
    const A = makeDevice("A", clockFrom(9_850_000).now);

    // Writes with capture active (sync not yet connected on desktop) stage rows
    // into sync_pending via the triggers.
    q.createWorkspace(A.db, { id: "ws1", name: "WS" });
    q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
    q.createNote(A.db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "N", content: "c" });
    expect((A.db.prepare("SELECT COUNT(*) c FROM sync_pending").get() as { c: number }).c).toBeGreaterThan(0);

    // First connect → backfill seeds current state AND clears the now-subsumed
    // pending rows, so a subsequent drain produces no redundant ops.
    A.engine.backfill();
    expect((A.db.prepare("SELECT COUNT(*) c FROM sync_pending").get() as { c: number }).c).toBe(0);
    expect(A.engine.drainPending()).toBe(0);
  });

  it("migrates a legacy sync_row_base (base_hlc) table without breaking drain", () => {
    const db = new BetterSqlite3(":memory:");
    applySchema(db);
    // Simulate the earlier engine build that created a NOT NULL base_hlc table.
    db.prepare(
      `CREATE TABLE sync_row_base (
         entity TEXT NOT NULL, entity_id TEXT NOT NULL, base_hlc TEXT NOT NULL,
         PRIMARY KEY (entity, entity_id)
       )`,
    ).run();
    db.prepare("INSERT INTO sync_row_base (entity, entity_id, base_hlc) VALUES ('notes','n1','stale')").run();

    // Constructing the engine must migrate the table to the base_body shape.
    const engine = new SyncEngine(db, "A", { now: clockFrom(11_000_000).now });
    const cols = (db.prepare("PRAGMA table_info(sync_row_base)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("base_body");
    expect(cols).not.toContain("base_hlc");

    // A normal create + drain (which writes base_body) must now succeed.
    q.createWorkspace(db, { id: "ws1", name: "WS" });
    q.createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    q.createNote(db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "N", content: "hello" });
    expect(() => engine.drainPending()).not.toThrow();
    const base = db.prepare("SELECT base_body FROM sync_row_base WHERE entity='notes' AND entity_id='n1'").get() as { base_body: string } | undefined;
    expect(base?.base_body).toBe("hello");
  });
});
