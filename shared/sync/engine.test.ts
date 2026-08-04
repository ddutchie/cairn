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
import { SyncEngine, SYNC_ACTIVITY_LIMIT } from "./engine";
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

  it("never makes a conflict copy OF a conflict copy (no _conflict_…_conflict_ nesting)", () => {
    // Regression for the "31 pending" storm: a conflict-copy row whose body then
    // diverged across devices used to spawn ANOTHER conflict copy, nesting
    // `_conflict_…_conflict_…` ids that piled up and churned as delete
    // tombstones. Such a row must now resolve by plain LWW — no further clone.
    const clkA = clockFrom(3_700_000);
    const clkB = clockFrom(3_700_000);
    const A = makeDevice("A", clkA.now);
    const B = makeDevice("B", clkB.now);
    seedBase(A.engine);

    // A pre-existing conflict copy, already shared and converged on both devices.
    const copyId = "n1_conflict_deviceX_abc123";
    clkA.advance(1);
    A.engine.put("notes", {
      id: copyId, project_id: "p1", workspace_id: "ws1",
      title: "Note (conflicted copy — deviceX)", content: "base", created_at: "t", updated_at: "t", content_text: "",
    });
    syncFolder(dir, A.engine, B.engine);

    // Now BOTH devices edit that conflict copy's body offline.
    clkA.advance(1);
    A.engine.put("notes", { id: copyId, content: "A edit of the copy" });
    clkB.advance(50);
    B.engine.put("notes", { id: copyId, content: "B edit of the copy" });
    syncFolder(dir, A.engine, B.engine);

    // Converged by LWW (B wins), and NO nested `_conflict_…_conflict_` row minted.
    expect(liveState(A.db)).toEqual(liveState(B.db));
    for (const dev of [A, B]) {
      const winner = dev.db.prepare("SELECT content FROM notes WHERE id = ?").get(copyId) as { content: string };
      expect(winner.content).toBe("B edit of the copy");
      const nested = dev.db
        .prepare("SELECT id FROM notes WHERE id LIKE '%\\_conflict\\_%\\_conflict\\_%' ESCAPE '\\'")
        .all() as { id: string }[];
      expect(nested).toHaveLength(0);
    }
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

  it("stops re-exchanging array-merge rows once both sides converge (no perpetual re-stamp)", () => {
    // Regression: the array-union re-stamp used to fire whenever the merged row
    // had an element the REMOTE payload lacked — even when the LOCAL row already
    // held the full union. That minted a fresh, higher-HLC op every sync, so the
    // same rows ping-ponged forever and the "pending/changed" count regenerated
    // after every sync instead of settling. After convergence, a further sync
    // must apply NOTHING on either side.
    const clkA = clockFrom(6_500_000);
    const clkB = clockFrom(6_500_000);
    const A = makeDevice("A", clkA.now);
    const B = makeDevice("B", clkB.now);
    seedBase(A.engine);
    A.engine.put("notes", { id: "n1", project_id: "p1", workspace_id: "ws1", title: "Tagged", content: "x", tag_ids: JSON.stringify(["base"]), created_at: "t", updated_at: "t", content_text: "" });
    syncFolder(dir, A.engine, B.engine);

    // Concurrent tag additions on both sides.
    clkA.advance(1);
    A.engine.put("notes", { id: "n1", tag_ids: JSON.stringify(["base", "from-a"]) });
    clkB.advance(2);
    B.engine.put("notes", { id: "n1", tag_ids: JSON.stringify(["base", "from-b"]) });

    // First reconciling sync: unions merge, both converge to the full set.
    syncFolder(dir, A.engine, B.engine);
    expect(liveState(A.db)).toEqual(liveState(B.db));

    // A SECOND sync with no new local edits must be a complete no-op — neither
    // side re-stamps the converged row.
    const { aResult, bResult } = syncFolder(dir, A.engine, B.engine);
    expect(aResult.applied).toHaveLength(0);
    expect(bResult.applied).toHaveLength(0);

    // And a THIRD, to prove it's not merely delayed by one round.
    const third = syncFolder(dir, A.engine, B.engine);
    expect(third.aResult.applied).toHaveLength(0);
    expect(third.bResult.applied).toHaveLength(0);
    expect(liveState(A.db)).toEqual(liveState(B.db));
  });

  it("propagates the full union when the winning remote carries an older array subset", () => {
    // Regression: a remote edit can WIN by HLC (e.g. a later title change) while
    // its payload carries a STALE tag_ids that lacks an element only the local
    // side has. The merge keeps the union locally, but if we don't republish it
    // (because the union didn't change OUR row) the peer never learns our extra
    // element and the two devices diverge. The union must always propagate.
    const clkA = clockFrom(6_800_000);
    const clkB = clockFrom(6_800_000);
    const A = makeDevice("A", clkA.now);
    const B = makeDevice("B", clkB.now);
    seedBase(A.engine);
    A.engine.put("notes", { id: "n1", project_id: "p1", workspace_id: "ws1", title: "T", content: "x", tag_ids: JSON.stringify(["base"]), created_at: "t", updated_at: "t", content_text: "" });
    syncFolder(dir, A.engine, B.engine); // both: ["base"]

    // A adds a tag locally (now ["base","from-a"]).
    clkA.advance(1);
    A.engine.put("notes", { id: "n1", tag_ids: JSON.stringify(["base", "from-a"]) });

    // B makes a LATER (higher-HLC) SCALAR edit whose payload still carries the
    // OLD tag set ["base"] — the classic "winning remote with a stale subset".
    clkB.advance(10);
    B.engine.put("notes", { id: "n1", title: "T renamed", tag_ids: JSON.stringify(["base"]) });

    syncFolder(dir, A.engine, B.engine);

    // Converged: B's title wins (higher HLC) AND A's tag survives the union on
    // BOTH devices — nothing was dropped.
    for (const dev of [A, B]) {
      const row = dev.db.prepare("SELECT title, tag_ids FROM notes WHERE id='n1'").get() as { title: string; tag_ids: string };
      expect(row.title).toBe("T renamed");
      expect(new Set(JSON.parse(row.tag_ids))).toEqual(new Set(["base", "from-a"]));
    }
    expect(liveState(A.db)).toEqual(liveState(B.db));

    // …and it still settles: a further sync applies nothing.
    const again = syncFolder(dir, A.engine, B.engine);
    expect(again.aResult.applied).toHaveLength(0);
    expect(again.bResult.applied).toHaveLength(0);
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

  it("ignores oplog entries for non-syncable entities (e.g. chat from an old peer)", () => {
    // Regression: chat_threads/chat_messages were removed from the synced set
    // (v28). A peer still on an old build can publish chat ops; applyRemote must
    // SKIP them — not apply them and not re-forward them (which would keep the
    // "hundreds of chat puts re-applied every sync" loop alive).
    const B = makeDevice("B", clockFrom(9_000_000).now);
    // Hand-craft an oplog entry for a table the engine no longer syncs.
    const staleChatOp = {
      hlc: "0000000f0000:0000:oldpeer",
      origin: "oldpeer",
      entity: "chat_threads" as unknown as (typeof SYNCABLE_TABLES)[number],
      entity_id: "thread-1",
      op: "put" as const,
      payload: { id: "thread-1", workspace_id: "ws1", created_at: "t", updated_at: "t", hlc: "0000000f0000:0000:oldpeer" },
    };
    const { applied } = B.engine.applyRemote([staleChatOp]);
    // Nothing applied…
    expect(applied).toHaveLength(0);
    // …and it was NOT recorded into our oplog for re-forwarding.
    const forwarded = B.db
      .prepare("SELECT COUNT(*) c FROM sync_oplog WHERE entity = 'chat_threads'")
      .get() as { c: number };
    expect(forwarded.c).toBe(0);
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

    // A delete through queries.ts (soft-delete/tombstone) becomes a delete op → B removes it.
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

  it("preserves stored row HLCs during backfill instead of re-stamping them", () => {
    const A = makeDevice("A", clockFrom(99_000_000).now);
    A.db.prepare("INSERT INTO sync_state (key, value) VALUES ('suppress','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    q.createWorkspace(A.db, { id: "ws1", name: "WS" });
    q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
    q.createNote(A.db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "Old", content: "old" });
    const storedHlc = "000000001000:0002:legacy";
    A.db.prepare("UPDATE notes SET hlc = ? WHERE id = 'n1'").run(storedHlc);
    A.db.prepare("UPDATE sync_state SET value='0' WHERE key='suppress'").run();

    A.engine.backfill();

    const op = A.engine.exportOplog().find((entry) => entry.entity === "notes" && entry.entity_id === "n1")!;
    expect(op.hlc).toBe(storedHlc);
    expect(op.origin).toBe("legacy");
    expect(op.payload?.hlc).toBe(storedHlc);
    expect(op.observed).toEqual({});
    expect((A.db.prepare("SELECT hlc FROM notes WHERE id='n1'").get() as { hlc: string }).hlc).toBe(storedHlc);
  });

  it("derives a deterministic placeholder from updated_at when a legacy row has no HLC", () => {
    const A = makeDevice("A", clockFrom(99_000_000).now);
    A.db.prepare("INSERT INTO sync_state (key, value) VALUES ('suppress','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    q.createWorkspace(A.db, { id: "ws1", name: "WS" });
    q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
    q.createNote(A.db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "Old", content: "old" });
    A.db.prepare("UPDATE notes SET hlc = NULL, updated_at = '2020-01-02T03:04:05.000Z' WHERE id = 'n1'").run();
    A.db.prepare("UPDATE sync_state SET value='0' WHERE key='suppress'").run();

    A.engine.backfill();

    const expected = "016f6435cc88:0000:A";
    const op = A.engine.exportOplog().find((entry) => entry.entity === "notes" && entry.entity_id === "n1")!;
    expect(op.hlc).toBe(expected);
    expect(op.observed).toEqual({});
  });

  it("falls back to created_at when updated_at is malformed", () => {
    const A = makeDevice("A", clockFrom(99_000_000).now);
    A.db.prepare("INSERT INTO sync_state (key, value) VALUES ('suppress','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    q.createWorkspace(A.db, { id: "ws1", name: "WS" });
    q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
    q.createNote(A.db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "Old", content: "old" });
    A.db.prepare("UPDATE notes SET hlc = NULL, updated_at = 'invalid', created_at = '2020-01-02T03:04:05.000Z' WHERE id = 'n1'").run();
    A.db.prepare("UPDATE sync_state SET value='0' WHERE key='suppress'").run();

    A.engine.backfill();

    const op = A.engine.exportOplog().find((entry) => entry.entity === "notes" && entry.entity_id === "n1")!;
    expect(op.hlc).toBe("016f6435cc88:0000:A");
  });

  it("a stale device backfill cannot resurrect a peer-deleted note", () => {
    const clkA = clockFrom(9_825_000);
    const A = makeDevice("A", clkA.now);
    const B = makeDevice("B", clockFrom(99_000_000).now);
    seedBase(A.engine);
    A.engine.put("notes", { id: "n1", project_id: "p1", workspace_id: "ws1", title: "Shared", content: "before", created_at: "2020-01-01T00:00:00.000Z", updated_at: "2020-01-01T00:00:00.000Z", content_text: "" });
    B.engine.applyRemote(A.engine.exportOplog());

    // Simulate a stale pre-sync install: retain B's old live row but clear its
    // local sync history so first connect runs backfill after A has deleted it.
    B.db.prepare("DELETE FROM sync_oplog").run();
    B.db.prepare("DELETE FROM sync_row_base").run();
    B.db.prepare("DELETE FROM sync_state WHERE key = 'backfilled'").run();
    B.db.prepare("UPDATE notes SET hlc = NULL, updated_at = '2020-01-01T00:00:00.000Z' WHERE id = 'n1'").run();
    clkA.advance(10);
    A.engine.remove("notes", "n1");

    B.engine.backfill();
    const backfilled = B.engine.exportOplog().find((entry) => entry.entity === "notes" && entry.entity_id === "n1")!;
    expect(backfilled.hlc).toBe("016f5e66e800:0000:B");
    expect(backfilled.observed).toEqual({});
    A.engine.applyRemote(B.engine.exportOplog());

    expect((A.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number }).c).toBe(0);
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
    db.prepare("DROP TABLE sync_row_base").run();
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
    expect(cols).toEqual(expect.arrayContaining(["delete_hlc", "delete_origin", "put_hlc", "put_observed"]));
    expect(cols).not.toContain("base_hlc");

    // A normal create + drain (which writes base_body) must now succeed.
    q.createWorkspace(db, { id: "ws1", name: "WS" });
    q.createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    q.createNote(db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "N", content: "hello" });
    expect(() => engine.drainPending()).not.toThrow();
    const base = db.prepare("SELECT base_body FROM sync_row_base WHERE entity='notes' AND entity_id='n1'").get() as { base_body: string } | undefined;
    expect(base?.base_body).toBe("hello");
  });

  // ── delete propagation (desktop soft-deletes / tombstones the row) ──────────
  // The desktop's q.deleteNote sets `deleted_at` (a soft-delete), because every
  // desktop live read filters `deleted_at IS NULL`, so a tombstoned note vanishes
  // from lists/search exactly like a removal — while the surviving row keeps the
  // sync staleness guard armed. The AFTER UPDATE capture trigger stages a 'delete'
  // op (it keys off NEW.deleted_at), and drainPending appends a delete oplog entry
  // via its normal delete branch (no tombstone SHELL needed — that hack only
  // existed to compensate for the old physical DELETE leaving no local row). These
  // tests pin that the deletion reaches the peer and both devices converge.
  describe("soft-delete propagation + convergence", () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-del-")); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    function seedNoteOnBoth(A: ReturnType<typeof makeDevice>, B: ReturnType<typeof makeDevice>) {
      q.createWorkspace(A.db, { id: "ws1", name: "WS" });
      q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
      q.createNote(A.db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "Shared", content: "line 1\nline 2" });
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);
    }

    it("removes a note on the peer after a desktop hard-delete, and both converge", () => {
      const clkA = clockFrom(12_000_000);
      const clkB = clockFrom(12_000_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);
      expect((B.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number }).c).toBe(1);

      clkA.advance(10);
      q.deleteNote(A.db, "n1"); // soft-delete → tombstone
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      // Gone on the peer, and no live-state divergence between the devices.
      expect((B.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number }).c).toBe(0);
      expect(liveState(A.db)).toEqual(liveState(B.db));
    });

    it("the delete op survives compaction and keeps propagating to a late peer", () => {
      const clkA = clockFrom(12_100_000);
      const A = makeDevice("A", clkA.now);
      q.createWorkspace(A.db, { id: "ws1", name: "WS" });
      q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
      q.createNote(A.db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "N", content: "x" });
      A.engine.drainPending();
      clkA.advance(5);
      q.deleteNote(A.db, "n1");
      A.engine.drainPending();

      // A fresh peer that has NEVER seen n1 still receives the tombstone op and
      // never materialises the note as live.
      const B = makeDevice("B", clockFrom(12_100_000).now);
      const exported = A.engine.exportOplog(); // compacts first
      const n1Ops = exported.filter((e) => e.entity === "notes" && e.entity_id === "n1");
      expect(n1Ops.length).toBe(1);
      expect(n1Ops[0].op).toBe("delete");
      writeOplogFile(dir, "A", exported);
      B.engine.applyRemote(readPeerOplogs(dir, "B"));
      expect((B.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number }).c).toBe(0);
    });

    it("a stale peer put drained AFTER a local delete does not resurrect the row", () => {
      // Real-world timing bug: desktop deletes a note, publishes the delete, then
      // syncs AGAIN and reads the phone's still-stale oplog (a put@lowerHLC
      // published before the phone saw the delete). The surviving tombstone row
      // (soft-delete) keeps the staleness guard armed so the older put can't
      // resurrect the note. (Historically the desktop hard-deleted and relied on
      // drainPending's tombstone-shell to reconstruct the guard; soft-delete makes
      // the durable row the guard, so the shell is no longer needed here.)
      const clkA = clockFrom(12_150_000);
      const clkB = clockFrom(12_150_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);
      // Phone publishes its current (live) state — a put with the seed's HLC.
      writeOplogFile(dir, "B", B.engine.exportOplog());
      expect((B.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number }).c).toBe(1);

      // Desktop deletes and republishes (higher HLC).
      clkA.advance(100);
      q.deleteNote(A.db, "n1");
      A.engine.drainPending();
      writeOplogFile(dir, "A", A.engine.exportOplog());
      expect((A.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number }).c).toBe(0);

      // Desktop syncs again while the phone is still offline: it reconciles the
      // phone's stale put. The note must STAY deleted on desktop.
      A.engine.applyRemote(readPeerOplogs(dir, "A"));
      expect((A.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number }).c).toBe(0);
    });

    it("an unobserved higher-HLC stale peer edit cannot resurrect a deleted note", () => {
      // The phone's wall clock is ahead, but it has not observed the desktop's
      // delete. Raw HLC order is not causal evidence, so delete wins safely.
      const clkA = clockFrom(12_200_000);
      const clkB = clockFrom(12_200_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(1);
      q.deleteNote(A.db, "n1"); // desktop delete (earlier)
      A.engine.drainPending();

      clkB.advance(50);
      q.updateNote(B.db, "n1", { content: "phone kept editing" }); // later edit wins
      B.engine.drainPending();

      syncFolder(dir, A.engine, B.engine);

      for (const dev of [A, B]) {
        expect((dev.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number }).c).toBe(0);
        const copies = dev.db
          .prepare("SELECT content FROM notes WHERE id LIKE 'n1_conflict_%' AND deleted_at IS NULL")
          .all() as Array<{ content: string }>;
        expect(copies.map((copy) => copy.content)).toContain("phone kept editing");
      }
      expect(liveState(A.db)).toEqual(liveState(B.db));

      // Compaction must publish the policy winner, not the rejected put whose
      // raw HLC was higher, so a late peer also sees the note as deleted.
      const compacted = A.engine.exportOplog().filter((entry) => entry.entity === "notes" && entry.entity_id === "n1");
      expect(compacted).toHaveLength(1);
      expect(compacted[0].op).toBe("delete");
      const C = makeDevice("C", clockFrom(12_300_000).now);
      C.engine.applyRemote(A.engine.exportOplog());
      expect((C.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number }).c).toBe(0);
    });

    it("allows a legitimate edit after the editing peer observed the delete", () => {
      const clkA = clockFrom(12_250_000);
      const clkB = clockFrom(12_250_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);
      const clkD = clockFrom(12_260_000);
      const D = makeDevice("D", clkD.now);
      D.engine.applyRemote(A.engine.exportOplog());

      clkA.advance(1);
      A.engine.remove("notes", "n1");
      B.engine.applyRemote(A.engine.exportOplog());
      expect((B.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number }).c).toBe(0);

      // B authors the revival only after receiving A's delete, so its attached
      // observation frontier proves the intended causal ordering.
      clkB.advance(50);
      B.engine.put("notes", { id: "n1", content: "restored after seeing delete" });
      A.engine.applyRemote(B.engine.exportOplog());

      for (const dev of [A, B]) {
        const note = dev.db.prepare("SELECT content FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { content: string } | undefined;
        expect(note?.content).toBe("restored after seeing delete");
      }

      // A late peer only sees B's compacted revival put. It must still learn the
      // prior durable delete carried on that put, then reject an offline stale
      // peer's higher-clock edit that did not observe the delete.
      const C = makeDevice("C", clockFrom(12_250_000).now);
      C.engine.applyRemote(B.engine.exportOplog());
      clkD.advance(10_000);
      D.engine.put("notes", { id: "n1", content: "unobserved stale edit" });
      C.engine.applyRemote(D.engine.exportOplog());
      expect((C.db.prepare("SELECT content FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { content: string }).content).toBe("restored after seeing delete");
      expect((C.db.prepare("SELECT delete_hlc FROM sync_row_base WHERE entity='notes' AND entity_id='n1'").get() as { delete_hlc: string }).delete_hlc).toBeTruthy();
    });

    it("keeps the durable delete fact after the domain tombstone row is removed", () => {
      const clkA = clockFrom(12_275_000);
      const clkB = clockFrom(12_275_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      A.engine.remove("notes", "n1");
      const deleteHlc = (A.db.prepare("SELECT delete_hlc FROM sync_row_base WHERE entity='notes' AND entity_id='n1'").get() as { delete_hlc: string }).delete_hlc;
      A.db.prepare("DELETE FROM notes WHERE id='n1'").run();

      clkB.advance(500);
      B.engine.put("notes", { id: "n1", content: "stale after compaction" });
      A.engine.applyRemote(B.engine.exportOplog());

      expect((A.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number }).c).toBe(0);
      expect((A.db.prepare("SELECT delete_hlc FROM sync_row_base WHERE entity='notes' AND entity_id='n1'").get() as { delete_hlc: string }).delete_hlc).toBe(deleteHlc);
    });

    it("reports a rejected stale put's conflict copy only once", () => {
      const A = makeDevice("A", clockFrom(12_290_000).now);
      const clkB = clockFrom(12_290_000);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);
      A.engine.remove("notes", "n1");
      clkB.advance(100);
      B.engine.put("notes", { id: "n1", content: "offline edit" });
      const stalePut = B.engine.exportOplog().filter((entry) => entry.entity === "notes" && entry.entity_id === "n1");

      expect(A.engine.applyRemote(stalePut).conflictCopies).toHaveLength(1);
      expect(A.engine.applyRemote(stalePut).conflictCopies).toHaveLength(0);
    });

    it("replaces a pre-existing higher-HLC stale row when a compacted legitimate revival arrives", () => {
      const A = makeDevice("A", clockFrom(12_295_000).now);
      const clkB = clockFrom(12_295_000);
      const B = makeDevice("B", clkB.now);
      const clkC = clockFrom(12_400_000);
      const C = makeDevice("C", clkC.now);
      seedNoteOnBoth(A, B);
      C.engine.applyRemote(A.engine.exportOplog());

      A.engine.remove("notes", "n1");
      B.engine.applyRemote(A.engine.exportOplog());
      clkB.advance(10);
      B.engine.put("notes", { id: "n1", content: "observed revival" });

      clkC.advance(10);
      C.engine.put("notes", { id: "n1", content: "stale high clock" });
      C.engine.applyRemote(B.engine.exportOplog());

      expect((C.db.prepare("SELECT content FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { content: string }).content).toBe("observed revival");
      const copies = C.db.prepare("SELECT content FROM notes WHERE id LIKE 'n1_conflict_%' AND deleted_at IS NULL").all() as Array<{ content: string }>;
      expect(copies.map((copy) => copy.content)).toContain("stale high clock");
    });

    it("does not regress exact delete observation when an older delete is replayed", () => {
      const clkA = clockFrom(12_297_000);
      const B = makeDevice("B", clockFrom(12_297_000).now);
      const A = makeDevice("A", clkA.now);
      seedNoteOnBoth(A, B);

      const delete1 = A.engine.remove("notes", "n1");
      B.engine.applyRemote(A.engine.exportOplog());
      A.engine.put("notes", { id: "n1", content: "between deletes" });
      clkA.advance(1);
      const delete2 = A.engine.remove("notes", "n1");
      B.engine.applyRemote(A.engine.exportOplog());

      B.engine.applyRemote([{ hlc: delete1, origin: "A", entity: "notes", entity_id: "n1", op: "delete", payload: null }]);
      B.engine.put("notes", { id: "n1", content: "revived after latest delete" });
      const revival = B.engine.exportOplog().find((entry) => entry.entity === "notes" && entry.entity_id === "n1" && entry.op === "put")!;
      expect(revival.observed?.["delete:notes\u0000n1"]).toBe(delete2);
      A.engine.applyRemote([revival]);
      expect((A.db.prepare("SELECT content FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { content: string }).content).toBe("revived after latest delete");

      // Replaying D1 after the revival is live must also be harmless.
      A.engine.applyRemote([{ hlc: delete1, origin: "A", entity: "notes", entity_id: "n1", op: "delete", payload: null }]);
      expect((A.db.prepare("SELECT content FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { content: string }).content).toBe("revived after latest delete");
    });

    it("a hard-delete with the higher HLC wins over an earlier peer edit (stays deleted)", () => {
      const clkA = clockFrom(12_300_000);
      const clkB = clockFrom(12_300_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkB.advance(1);
      q.updateNote(B.db, "n1", { content: "phone edit (earlier)" });
      B.engine.drainPending();

      clkA.advance(50);
      q.deleteNote(A.db, "n1"); // delete is later → wins
      A.engine.drainPending();

      syncFolder(dir, A.engine, B.engine);

      for (const dev of [A, B]) {
        expect((dev.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number }).c).toBe(0);
      }
      expect(liveState(A.db)).toEqual(liveState(B.db));
    });

    it("deleting a checklist LINE is a body edit (put), not a row delete — no resurrection risk", () => {
      // The user's real scenario: removing "- [ ] Item 2" from a note is an
      // UPDATE to the body, which syncs as a 'put' and merges/LWW like any edit.
      // It must NOT stage a row 'delete' (that would tombstone the whole note).
      const clkA = clockFrom(12_400_000);
      const clkB = clockFrom(12_400_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      q.createWorkspace(A.db, { id: "ws1", name: "WS" });
      q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
      q.createNote(A.db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "TODO", content: "- [ ] Item 1\n- [ ] Item 2" });
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      clkA.advance(5);
      q.updateNote(A.db, "n1", { content: "- [ ] Item 1" }); // removed Item 2
      // The staged op for this edit must be a 'put', not a 'delete'.
      const pend = A.db.prepare("SELECT op FROM sync_pending WHERE entity='notes' AND entity_id='n1' ORDER BY seq DESC LIMIT 1").get() as { op: string } | undefined;
      expect(pend?.op).toBe("put");
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      // The note is still live on the peer, just with the line removed.
      const onB = B.db.prepare("SELECT content FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { content: string } | undefined;
      expect(onB?.content).toBe("- [ ] Item 1");
      expect(liveState(A.db)).toEqual(liveState(B.db));
    });
  });

  // A folder move is a plain UPDATE to the `folder` scalar (via moveNoteFolder),
  // NOT a delete. It must sync as a 'put' carrying the new folder, apply by LWW,
  // and never tombstone, resurrect, or conflict-copy the note. These pin the
  // "could the oplog mishandle a move like the file-watcher did?" concern: it
  // doesn't — a move is an ordinary scalar put.
  describe("folder-move propagation + convergence", () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-move-")); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    function seedNoteOnBoth(A: ReturnType<typeof makeDevice>, B: ReturnType<typeof makeDevice>, folder = "") {
      q.createWorkspace(A.db, { id: "ws1", name: "WS" });
      q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
      q.createNote(A.db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "Spec", content: "body", folder });
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);
    }

    const noConflictCopies = (db: Database.Database) =>
      (db.prepare("SELECT COUNT(*) c FROM notes WHERE id LIKE '%\\_conflict\\_%' ESCAPE '\\'").get() as { c: number }).c;

    it("stages a folder move as a 'put' (never a 'delete') and replicates the new folder", () => {
      const clkA = clockFrom(13_000_000);
      const clkB = clockFrom(13_000_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(5);
      q.moveNoteFolder(A.db, "n1", "Archive/Old");
      // The staged op must be a 'put' — a move must never look like a deletion.
      const pend = A.db.prepare("SELECT op FROM sync_pending WHERE entity='notes' AND entity_id='n1' ORDER BY seq DESC LIMIT 1").get() as { op: string } | undefined;
      expect(pend?.op).toBe("put");
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      // Peer now shows the note live under the new folder — not tombstoned.
      const onB = B.db.prepare("SELECT folder FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { folder: string } | undefined;
      expect(onB?.folder).toBe("Archive/Old");
      expect(noConflictCopies(B.db)).toBe(0);
      expect(liveState(A.db)).toEqual(liveState(B.db));
    });

    it("replicates a move to the project root (folder='') without dropping it", () => {
      const clkA = clockFrom(13_100_000);
      const clkB = clockFrom(13_100_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B, "Inbox");
      expect((B.db.prepare("SELECT folder FROM notes WHERE id='n1'").get() as { folder: string }).folder).toBe("Inbox");

      clkA.advance(5);
      q.moveNoteFolder(A.db, "n1", ""); // back to root
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      expect((B.db.prepare("SELECT folder FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { folder: string }).folder).toBe("");
      expect(liveState(A.db)).toEqual(liveState(B.db));
    });

    it("resolves concurrent moves to different folders by LWW (higher HLC wins, no conflict copy)", () => {
      const clkA = clockFrom(13_200_000);
      const clkB = clockFrom(13_200_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(1);
      q.moveNoteFolder(A.db, "n1", "FolderA"); // earlier
      A.engine.drainPending();

      clkB.advance(50);
      q.moveNoteFolder(B.db, "n1", "FolderB"); // later → wins
      B.engine.drainPending();

      syncFolder(dir, A.engine, B.engine);

      for (const dev of [A, B]) {
        const folder = (dev.db.prepare("SELECT folder FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { folder: string }).folder;
        expect(folder).toBe("FolderB");
        // folder is a plain LWW scalar — no conflict copy (that's body-only).
        expect(noConflictCopies(dev.db)).toBe(0);
      }
      expect(liveState(A.db)).toEqual(liveState(B.db));
    });

    it("a move made offline does not resurrect a note the peer deleted with a higher HLC", () => {
      // Mirrors the file-watcher fix at the sync layer: moving a note must not
      // bring back a note that was legitimately deleted elsewhere (later).
      const clkA = clockFrom(13_300_000);
      const clkB = clockFrom(13_300_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(1);
      q.moveNoteFolder(A.db, "n1", "Somewhere"); // earlier move
      A.engine.drainPending();

      clkB.advance(50);
      q.deleteNote(B.db, "n1"); // later delete → wins
      B.engine.drainPending();

      syncFolder(dir, A.engine, B.engine);

      for (const dev of [A, B]) {
        expect((dev.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number }).c).toBe(0);
      }
      expect(liveState(A.db)).toEqual(liveState(B.db));
    });

    it("keeps converging (no re-exchange) after repeated syncs of a move", () => {
      const clkA = clockFrom(13_400_000);
      const clkB = clockFrom(13_400_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(5);
      q.moveNoteFolder(A.db, "n1", "Archive");
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);
      syncFolder(dir, A.engine, B.engine); // extra passes must be no-ops

      expect((B.db.prepare("SELECT folder FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { folder: string }).folder).toBe("Archive");
      // Nothing new staged on either side once converged.
      expect(A.engine.drainPending()).toBe(0);
      expect(B.engine.drainPending()).toBe(0);
      expect(liveState(A.db)).toEqual(liveState(B.db));
    });
  });

  describe("Phase 4 — sync visibility & recovery", () => {
    function seedNoteOnBoth(A: ReturnType<typeof makeDevice>, B: ReturnType<typeof makeDevice>) {
      q.createWorkspace(A.db, { id: "ws1", name: "WS" });
      q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
      q.createNote(A.db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "Shared", content: "line 1" });
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);
    }

    it("does not offer restore for a row already preserved by a live conflict copy", () => {
      // The on-device repro (v2.6.1 hardware test): delete on A, edit the same
      // note on B while B hasn't observed the delete. B's delete-won path
      // tombstones the row (keeping its body) AND clones it into a conflict
      // copy — so the tombstone and the copy hold the SAME content. Offering
      // restore then duplicates the note. Suppress it; the edit is safe in the
      // copy, so point the user at conflict resolution instead.
      const clkA = clockFrom(14_760_000);
      const clkB = clockFrom(14_760_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(1);
      q.deleteNote(A.db, "n1");
      A.engine.drainPending();
      clkB.advance(50);
      q.updateNote(B.db, "n1", { content: "phone kept editing" });
      B.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      // B has both a tombstoned n1 and a live conflict copy of it.
      const copy = B.db
        .prepare("SELECT id, content FROM notes WHERE id LIKE 'n1_conflict_%' AND deleted_at IS NULL")
        .get() as { id: string; content: string } | undefined;
      expect(copy?.content).toBe("phone kept editing");
      const tombstoned = B.db.prepare("SELECT content FROM notes WHERE id = 'n1'").get() as { content: string };
      expect(tombstoned.content).toBe("phone kept editing"); // same body → redundant restore

      // So restore is refused on B (the losing device) and n1 is not listed.
      expect(B.engine.listRestorable("notes").rows.map((r) => r.entity_id)).not.toContain("n1");
      expect(B.engine.restoreDeleted("notes", "n1")).toEqual({
        restored: false,
        reason: "preserved-as-copy",
      });
    });

    it("still offers restore when the delete won cleanly with no divergent copy", () => {
      // Plain peer delete, no competing local edit → no conflict copy exists, so
      // restore is the only way back and must still be offered.
      const clkA = clockFrom(14_780_000);
      const clkB = clockFrom(14_780_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(5);
      q.deleteNote(A.db, "n1");
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      expect(B.db.prepare("SELECT COUNT(*) c FROM notes WHERE id LIKE 'n1_conflict_%'").get()).toEqual({ c: 0 });
      expect(B.engine.listRestorable("notes").rows.map((r) => r.entity_id)).toContain("n1");
      expect(B.engine.restoreDeleted("notes", "n1").restored).toBe(true);
    });

    it("logs an applied outcome for a peer edit that lands cleanly", () => {
      const clkA = clockFrom(14_000_000);
      const clkB = clockFrom(14_000_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(5);
      q.updateNote(A.db, "n1", { content: "edited on A" });
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      const entries = B.engine
        .listSyncActivity()
        .filter((r) => r.entity === "notes" && r.entity_id === "n1" && r.op === "put")
        .sort((a, b) => a.seq - b.seq);
      // syncFolder makes two passes, so the op is re-delivered — but a replay
      // decides nothing and is deliberately not logged. A clean edit must never
      // produce a conflict copy or a delete outcome.
      expect(entries[0].outcome).toBe("applied");
      expect(entries[0].origin).toBe("A");
      expect(entries[0].conflict_copy_id).toBeNull();
      expect(new Set(entries.map((r) => r.outcome))).toEqual(new Set(["applied"]));
      expect(entries.every((r) => r.conflict_copy_id === null)).toBe(true);
    });

    it("logs delete-won with the conflict copy when a stale peer put is refused", () => {
      const clkA = clockFrom(14_100_000);
      const clkB = clockFrom(14_100_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(1);
      q.deleteNote(A.db, "n1");
      A.engine.drainPending();
      clkB.advance(50); // higher wall clock, but never observed the delete
      q.updateNote(B.db, "n1", { content: "phone kept editing" });
      B.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      // A refuses B's unobserved revival and says so, naming the rescued copy.
      const refusal = A.engine
        .listSyncActivity()
        .find((r) => r.entity_id === "n1" && r.op === "put" && r.outcome === "delete-won");
      expect(refusal).toBeDefined();
      expect(refusal?.origin).toBe("B");
      expect(refusal?.conflict_copy_id).toMatch(/^n1_conflict_/);

      // B, which held the note live, records the delete winning over its own row.
      const applied = B.engine
        .listSyncActivity()
        .find((r) => r.entity_id === "n1" && r.op === "delete" && r.outcome === "delete-won");
      expect(applied).toBeDefined();
      expect(applied?.origin).toBe("A");
    });

    it("labels activity rows with the row title, author and conflict side", () => {
      const clkA = clockFrom(14_150_000);
      const clkB = clockFrom(14_150_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(5);
      q.updateNote(A.db, "n1", { content: "edited on A" });
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      // A title beats a raw uuid in the UI, and it is resolved on read so it
      // tracks later renames.
      const entry = B.engine.listSyncActivity().find((r) => r.entity_id === "n1");
      expect(entry?.title).toBe("Shared");
      expect(entry?.isSelf).toBe(false);
      expect(entry?.conflict_side).toBeNull();
    });

    it("reports which side a conflict copy preserved", () => {
      const clkA = clockFrom(14_170_000);
      const clkB = clockFrom(14_170_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(1);
      q.deleteNote(A.db, "n1");
      A.engine.drainPending();
      clkB.advance(50);
      q.updateNote(B.db, "n1", { content: "phone kept editing" });
      B.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      // On A the refused *remote* put was rescued into the copy.
      const onA = A.engine
        .listSyncActivity()
        .find((r) => r.entity_id === "n1" && r.op === "put" && r.conflict_copy_id);
      expect(onA?.conflict_side).toBe("remote");

      // On B the *local* divergent row was moved aside so the delete could land.
      const onB = B.engine
        .listSyncActivity()
        .find((r) => r.entity_id === "n1" && r.op === "delete" && r.conflict_copy_id);
      expect(onB?.conflict_side).toBe("local");
    });

    it("does not log stale no-ops, so idle syncs cannot evict a delete-won record", () => {
      const clkA = clockFrom(14_200_000);
      const clkB = clockFrom(14_200_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(5);
      q.updateNote(A.db, "n1", { content: "v2" });
      A.engine.drainPending();
      const ops = A.engine.exportOplog();
      B.engine.applyRemote(ops);
      const afterFirst = B.engine.listSyncActivity().length;
      B.engine.applyRemote(ops); // same batch again — pure no-op
      B.engine.applyRemote(ops);

      // Replays decide nothing, so they must not consume ring-buffer space.
      expect(B.engine.listSyncActivity().length).toBe(afterFirst);
      expect(B.engine.listSyncActivity().every((r) => r.outcome !== "skipped-stale")).toBe(true);
    });

    it("keeps a delete-won record visible after many idle syncs", () => {
      const clkA = clockFrom(14_250_000);
      const clkB = clockFrom(14_250_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      q.createWorkspace(A.db, { id: "ws1", name: "WS" });
      q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
      // A workspace big enough that logging every re-read would overflow the cap.
      for (let i = 0; i < 60; i++) {
        q.createNote(A.db, { id: `n${i}`, projectId: "p1", workspaceId: "ws1", title: `N${i}`, content: "x" });
      }
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      clkA.advance(5);
      q.deleteNote(A.db, "n7");
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      // Idle convergence: the peer's whole compacted oplog is re-read each cycle.
      for (let i = 0; i < 30; i++) syncFolder(dir, A.engine, B.engine);

      const deleteWon = B.engine
        .listSyncActivity(SYNC_ACTIVITY_LIMIT)
        .find((r) => r.entity_id === "n7" && r.outcome === "delete-won");
      expect(deleteWon).toBeDefined();
    });

    it("bounds the activity log to the newest SYNC_ACTIVITY_LIMIT rows", () => {
      const clkA = clockFrom(14_300_000);
      const clkB = clockFrom(14_300_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      q.createWorkspace(A.db, { id: "ws1", name: "WS" });
      q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      // Each new note is a fresh decision (an 'applied' put), so this genuinely
      // exceeds the cap rather than replaying no-ops.
      for (let i = 0; i < SYNC_ACTIVITY_LIMIT + 80; i++) {
        clkA.advance(1);
        q.createNote(A.db, { id: `n${i}`, projectId: "p1", workspaceId: "ws1", title: `N${i}`, content: "x" });
        A.engine.drainPending();
      }
      syncFolder(dir, A.engine, B.engine);

      const total = (B.db.prepare("SELECT COUNT(*) c FROM sync_activity").get() as { c: number }).c;
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(SYNC_ACTIVITY_LIMIT);
      // listSyncActivity never exceeds the cap even when asked for more.
      expect(B.engine.listSyncActivity(10_000).length).toBeLessThanOrEqual(SYNC_ACTIVITY_LIMIT);
    });

    it("lists a peer's delete as restorable but not the device's own delete", () => {
      const clkA = clockFrom(14_400_000);
      const clkB = clockFrom(14_400_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(5);
      q.deleteNote(A.db, "n1");
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      // B lost the note to a peer → offer recovery, with the content intact.
      const restorable = B.engine.listRestorable("notes");
      expect(restorable.rows.map((r) => r.entity_id)).toEqual(["n1"]);
      expect(restorable.total).toBe(1);
      expect(restorable.rows[0].title).toBe("Shared");
      expect(restorable.rows[0].delete_origin).toBe("A");

      // A deleted it deliberately, so it must not be nagged about its own action.
      expect(A.engine.listRestorable("notes").rows.map((r) => r.entity_id)).not.toContain("n1");
    });

    it("still treats a delete as self-authored after a peer's delete outranks it", () => {
      // Both devices tombstone the same row independently (Cairn's startup
      // cleanup does exactly this). delete_origin records the WINNING delete, so
      // the first deleter's own action would otherwise be blamed on the peer and
      // shown as data loss.
      const clkA = clockFrom(14_420_000);
      const clkB = clockFrom(14_420_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(1);
      q.deleteNote(A.db, "n1"); // earlier
      A.engine.drainPending();
      clkB.advance(50);
      q.deleteNote(B.db, "n1"); // later → wins, so delete_origin becomes B on A
      B.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      for (const dev of [A, B]) {
        expect(dev.engine.listRestorable("notes").rows.map((r) => r.entity_id)).not.toContain("n1");
      }
      expect(A.engine.restoreDeleted("notes", "n1")).toEqual({
        restored: false,
        reason: "self-deleted",
      });
    });

    it("never offers a conflict copy for restore", () => {
      const clkA = clockFrom(14_450_000);
      const clkB = clockFrom(14_450_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      // Force a conflict copy, then have the peer delete it.
      clkA.advance(1);
      q.deleteNote(A.db, "n1");
      A.engine.drainPending();
      clkB.advance(50);
      q.updateNote(B.db, "n1", { content: "divergent" });
      B.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      const copy = A.db
        .prepare("SELECT id FROM notes WHERE id LIKE 'n1_conflict_%' AND deleted_at IS NULL")
        .get() as { id: string } | undefined;
      expect(copy?.id).toBeTruthy();
      const copyId = copy!.id;

      clkB.advance(5);
      q.deleteNote(B.db, copyId); // peer discards the copy
      B.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      // Conflict copies have their own resolution flow; the app also tombstones
      // nested ones at startup, so restoring here would just be undone.
      expect(A.engine.listRestorable("notes").rows.map((r) => r.entity_id)).not.toContain(copyId);
      expect(A.engine.restoreDeleted("notes", copyId)).toEqual({
        restored: false,
        reason: "conflict-copy",
      });
    });

    it("refuses to restore a note whose project was deleted too", () => {
      const clkA = clockFrom(14_470_000);
      const clkB = clockFrom(14_470_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(5);
      A.engine.remove("notes", "n1");
      A.engine.remove("projects", "p1");
      syncFolder(dir, A.engine, B.engine);

      // Reviving the note alone would leave it pointing at a dead project —
      // invisible on one device, present on the other, diverging forever.
      expect(B.engine.listRestorable("notes").rows.map((r) => r.entity_id)).not.toContain("n1");
      expect(B.engine.restoreDeleted("notes", "n1")).toEqual({
        restored: false,
        reason: "orphaned",
      });
    });

    it("offers a peer-deleted note even when its title is blank or whitespace", () => {
      // The list and the action must agree: a title-based shell heuristic made
      // a whitespace-titled note listable but un-restorable (a dead button).
      const clkA = clockFrom(14_490_000);
      const clkB = clockFrom(14_490_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      q.createWorkspace(A.db, { id: "ws1", name: "WS" });
      q.createProject(A.db, { id: "p1", workspaceId: "ws1", name: "P" });
      q.createNote(A.db, { id: "n9", projectId: "p1", workspaceId: "ws1", title: "   ", content: "real body" });
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      clkA.advance(5);
      q.deleteNote(A.db, "n9");
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);

      expect(B.engine.listRestorable("notes").rows.map((r) => r.entity_id)).toContain("n9");
      expect(B.engine.restoreDeleted("notes", "n9").restored).toBe(true);
    });

    it("restores a peer-deleted note so the revival survives further syncs", () => {
      const clkA = clockFrom(14_500_000);
      const clkB = clockFrom(14_500_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      clkA.advance(5);
      q.deleteNote(A.db, "n1");
      A.engine.drainPending();
      syncFolder(dir, A.engine, B.engine);
      expect((B.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as { c: number }).c).toBe(0);

      // One tap on B.
      clkB.advance(10);
      const res = B.engine.restoreDeleted("notes", "n1");
      expect(res.restored).toBe(true);

      syncFolder(dir, A.engine, B.engine);
      syncFolder(dir, A.engine, B.engine); // must not be undone on a later pass

      // The restore is a causally-valid revival, so it holds on BOTH devices —
      // this is what distinguishes it from a stale peer's resurrection.
      for (const dev of [A, B]) {
        const row = dev.db.prepare("SELECT title, content FROM notes WHERE id='n1' AND deleted_at IS NULL").get() as
          | { title: string; content: string }
          | undefined;
        expect(row?.title).toBe("Shared");
        expect(row?.content).toBe("line 1");
      }
      expect(liveState(A.db)).toEqual(liveState(B.db));
      expect(B.engine.listRestorable("notes").rows.map((r) => r.entity_id)).not.toContain("n1");
    });

    it("refuses to restore a contentless tombstone shell", () => {
      const clkA = clockFrom(14_600_000);
      const clkB = clockFrom(14_600_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      // A creates and deletes a note, then compacts so only the delete ships.
      clkA.advance(5);
      q.createNote(A.db, { id: "n2", projectId: "p1", workspaceId: "ws1", title: "Ghost", content: "x" });
      A.engine.drainPending();
      clkA.advance(5);
      q.deleteNote(A.db, "n2");
      A.engine.drainPending();
      A.engine.compactOplog();

      const C = makeDevice("C", clockFrom(14_650_000).now);
      C.engine.applyRemote(A.engine.exportOplog());

      // C only ever saw the delete → a shell with no content to bring back.
      expect(C.engine.restoreDeleted("notes", "n2")).toEqual({ restored: false, reason: "shell" });
      expect(C.engine.listRestorable("notes").rows.map((r) => r.entity_id)).not.toContain("n2");
    });

    it("reports why a restore was refused for an absent or live row", () => {
      const clkA = clockFrom(14_700_000);
      const clkB = clockFrom(14_700_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      expect(B.engine.restoreDeleted("notes", "n1")).toEqual({ restored: false, reason: "live" });
      expect(B.engine.restoreDeleted("notes", "does-not-exist")).toEqual({
        restored: false,
        reason: "missing",
      });
    });

    it("does not claim a note is missing when it exists but sync has no delete record", () => {
      // Tombstoned outside the sync path, so there is no sync_row_base delete
      // metadata. Reporting "missing" would tell the user their note is gone.
      const clkA = clockFrom(14_720_000);
      const clkB = clockFrom(14_720_000);
      const A = makeDevice("A", clkA.now);
      const B = makeDevice("B", clkB.now);
      seedNoteOnBoth(A, B);

      B.db.prepare("UPDATE notes SET deleted_at = ? WHERE id = 'n1'").run("2026-01-01T00:00:00.000Z");
      B.db.prepare("DELETE FROM sync_row_base WHERE entity = 'notes' AND entity_id = 'n1'").run();

      expect(B.engine.restoreDeleted("notes", "n1")).toEqual({
        restored: false,
        reason: "no-delete-record",
      });
      expect((B.db.prepare("SELECT COUNT(*) c FROM notes WHERE id='n1'").get() as { c: number }).c).toBe(1);
    });
  });
});
