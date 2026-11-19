/**
 * The expo adapter's transaction() must nest like better-sqlite3's: expo-sqlite's
 * withTransactionSync is a bare BEGIN/COMMIT, so a fake with those exact semantics
 * (nesting throws) proves inner calls go through savepoints.
 */
import { describe, it, expect } from "vitest";
import { createExpoSyncDb } from "./expo-sync-db";

function fakeDb() {
  const log: string[] = [];
  let open = false;
  const db = {
    withTransactionSync(fn: () => void) {
      if (open) throw new Error("cannot start a transaction within a transaction");
      open = true;
      log.push("BEGIN");
      try {
        fn();
        log.push("COMMIT");
      } catch (e) {
        log.push("ROLLBACK");
        throw e;
      } finally {
        open = false;
      }
    },
    execSync(sql: string) {
      if (!open) throw new Error("savepoint outside a transaction");
      log.push(sql);
    },
    prepareSync: () => { throw new Error("unused"); },
  };
  return { db: db as never, log };
}

describe("createExpoSyncDb transaction", () => {
  it("nests through savepoints instead of a second BEGIN", () => {
    const { db, log } = fakeDb();
    const sync = createExpoSyncDb(db);
    const inner = sync.transaction(() => "inner");
    const out = sync.transaction(() => inner() + "+outer")();
    expect(out).toBe("inner+outer");
    expect(log).toEqual(["BEGIN", "SAVEPOINT cairn_sp_1", "RELEASE cairn_sp_1", "COMMIT"]);
  });

  it("rolls back only the inner savepoint when the inner function throws and the outer catches", () => {
    const { db, log } = fakeDb();
    const sync = createExpoSyncDb(db);
    const bad = sync.transaction(() => { throw new Error("boom"); });
    sync.transaction(() => { try { bad(); } catch { /* handled */ } })();
    expect(log).toEqual(["BEGIN", "SAVEPOINT cairn_sp_1", "ROLLBACK TO cairn_sp_1", "RELEASE cairn_sp_1", "COMMIT"]);
  });

  it("resets depth after a failed outer transaction", () => {
    const { db, log } = fakeDb();
    const sync = createExpoSyncDb(db);
    expect(() => sync.transaction(() => { throw new Error("x"); })()).toThrow("x");
    sync.transaction(() => 1)();
    expect(log).toEqual(["BEGIN", "ROLLBACK", "BEGIN", "COMMIT"]);
  });

  it("nests across two adapters made over the same handle", () => {
    const { db, log } = fakeDb();
    const a = createExpoSyncDb(db);
    const b = createExpoSyncDb(db);
    a.transaction(() => { b.transaction(() => 1)(); })();
    expect(log).toEqual(["BEGIN", "SAVEPOINT cairn_sp_1", "RELEASE cairn_sp_1", "COMMIT"]);
  });
});
