/**
 * Restore → file-projection integration tests (plan §4 Phase 4b).
 *
 * The DB half of a restore and the `.md` half can fail independently. These
 * cover the case that used to be unrecoverable: the row is revived and
 * published, but writing the note file throws. The row is live by then, so a
 * plain retry of the restore is correctly refused as `live` — `repairNoteFile`
 * is the path that makes it retryable.
 */

import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import * as q from "../db/queries";
import { getDesktopEngine, resetDesktopEngine, restoreDeletedNote, repairNoteFile } from "./desktop-sync";
import type { ConflictResolveDeps } from "./desktop-sync";

/**
 * A stand-in for the real dep, which writes the note row AND its file. `mode`
 * lets a test fail only the file half, exactly like a disk error would.
 */
function makeDeps(db: Database.Database, state: { fail: boolean; calls: string[] }): ConflictResolveDeps {
  return {
    updateNoteBody: (id, title, content) => {
      state.calls.push(id);
      if (state.fail) throw new Error("EACCES: permission denied");
      q.updateNote(db, id, { title, content });
    },
    deleteNoteRow: (id) => {
      q.deleteNote(db, id);
    },
  };
}

/** A note tombstoned by a peer, so it is genuinely restorable on this device. */
function seedPeerDeletedNote(db: Database.Database): void {
  q.createWorkspace(db, { id: "ws1", name: "WS" });
  q.createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
  q.createNote(db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "Shared", content: "body" });
  const engine = getDesktopEngine(db);
  engine.drainPending();

  // Emulate a peer's delete arriving over sync (not a local delete, which would
  // be excluded as self-authored).
  const peer = new BetterSqlite3(":memory:");
  applySchema(peer);
  const peerEngine = getDesktopEngine(peer);
  peerEngine.applyRemote(engine.exportOplog());
  peerEngine.remove("notes", "n1");
  engine.applyRemote(peerEngine.exportOplog());
  peer.close();
}

describe("restore → file projection", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    applySchema(db);
    // The cached engine is keyed on db identity, but these tests bind a second
    // (peer) db during seeding — reset so each case starts clean.
    resetDesktopEngine();
    getDesktopEngine(db);
  });

  it("restores the row and writes the file on the happy path", () => {
    seedPeerDeletedNote(db);
    const state = { fail: false, calls: [] as string[] };

    const res = restoreDeletedNote(db, "n1", makeDeps(db, state));

    expect(res).toEqual({ restored: true });
    expect(state.calls).toEqual(["n1"]);
    const row = db.prepare("SELECT deleted_at FROM notes WHERE id = 'n1'").get() as { deleted_at: string | null };
    expect(row.deleted_at).toBeNull();
  });

  it("reports fileError while still reviving the row when the file write fails", () => {
    seedPeerDeletedNote(db);
    const state = { fail: true, calls: [] as string[] };

    const res = restoreDeletedNote(db, "n1", makeDeps(db, state));

    // The DB half succeeded, so this must NOT read as a clean success or a
    // total failure — the caller has to be able to tell the difference.
    expect(res.restored).toBe(true);
    expect(res.fileError).toContain("EACCES");
    const row = db.prepare("SELECT deleted_at FROM notes WHERE id = 'n1'").get() as { deleted_at: string | null };
    expect(row.deleted_at).toBeNull();
  });

  it("refuses a plain restore retry after the row is already live", () => {
    seedPeerDeletedNote(db);
    const state = { fail: true, calls: [] as string[] };
    restoreDeletedNote(db, "n1", makeDeps(db, state));

    // This is why the repair path exists: the obvious retry is a dead end.
    const retry = restoreDeletedNote(db, "n1", makeDeps(db, state));
    expect(retry).toEqual({ restored: false, reason: "live" });
  });

  it("repairs the file for an already-live row once the write succeeds", () => {
    seedPeerDeletedNote(db);
    const state = { fail: true, calls: [] as string[] };
    const first = restoreDeletedNote(db, "n1", makeDeps(db, state));
    expect(first.fileError).toBeTruthy();

    // Disk problem resolved; the retry must not require tombstone eligibility.
    state.fail = false;
    const repaired = repairNoteFile(db, "n1", makeDeps(db, state));

    expect(repaired).toEqual({ repaired: true });
    expect(state.calls).toEqual(["n1", "n1"]);
  });

  it("keeps reporting the failure when the repair also fails", () => {
    seedPeerDeletedNote(db);
    const state = { fail: true, calls: [] as string[] };
    restoreDeletedNote(db, "n1", makeDeps(db, state));

    const repaired = repairNoteFile(db, "n1", makeDeps(db, state));

    expect(repaired.repaired).toBe(false);
    expect(repaired.fileError).toContain("EACCES");
  });

  it("refuses to repair a row that is missing or still deleted", () => {
    seedPeerDeletedNote(db);
    const state = { fail: false, calls: [] as string[] };

    expect(repairNoteFile(db, "nope", makeDeps(db, state))).toEqual({
      repaired: false,
      reason: "missing",
    });
    // Still tombstoned — repair projects live rows only; use restore for this.
    expect(repairNoteFile(db, "n1", makeDeps(db, state))).toEqual({
      repaired: false,
      reason: "deleted",
    });
    expect(state.calls).toEqual([]);
  });
});
