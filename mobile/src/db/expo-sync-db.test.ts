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

// The shared people code nests transactions (mergeTeams and mergePeople call
// helpers that open their own). Run it through the adapter over a real SQLite
// whose withTransactionSync is a bare BEGIN/COMMIT, as expo-sqlite's is.
describe("createExpoSyncDb with the shared people code", async () => {
  const { default: BetterSqlite3 } = await import("../../../vitest-sqlite-shim.cjs");
  const { MOBILE_SCHEMA_SQL, MOBILE_TRIGGERS_SQL } = await import("./schema");
  const { createTeam, addMember, mergeTeams, getTeam, listTeamMemberships } = await import("@cairn/shared/people/team-queries");
  const { mergePeople } = await import("@cairn/shared/people/merge");
  const { createPerson, getPerson } = await import("@cairn/shared/people/queries");

  /** expo-sqlite's surface over better-sqlite3: prepareSync/executeSync, execSync, and a savepoint-less withTransactionSync. */
  function expoOver(raw: import("better-sqlite3").Database) {
    return {
      execSync: (sql: string) => { raw.exec(sql); },
      withTransactionSync(fn: () => void) {
        raw.exec("BEGIN");
        try { fn(); raw.exec("COMMIT"); } catch (e) { raw.exec("ROLLBACK"); throw e; }
      },
      prepareSync(sql: string) {
        const st = raw.prepare(sql);
        return {
          executeSync: (params: unknown[] = []) => {
            if (st.reader) {
              const rows = st.all(...params) as unknown[];
              return { changes: 0, lastInsertRowId: 0, getFirstSync: () => rows[0] ?? null, getAllSync: () => rows };
            }
            const r = st.run(...params);
            return { changes: r.changes, lastInsertRowId: Number(r.lastInsertRowid), getFirstSync: () => null, getAllSync: () => [] };
          },
          finalizeSync: () => {},
        };
      },
    };
  }

  function setup() {
    const raw = new (BetterSqlite3 as unknown as new (f: string) => import("better-sqlite3").Database)(":memory:");
    raw.exec(MOBILE_SCHEMA_SQL);
    raw.exec(MOBILE_TRIGGERS_SQL);
    raw.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws1', 'W', 'x', 'x')").run();
    return { raw, db: createExpoSyncDb(expoOver(raw) as never) };
  }

  it("merges two teams (a transaction that nests the membership writes)", () => {
    const { db } = setup();
    const ana = createPerson(db, { workspaceId: "ws1", name: "Ana Ruiz" });
    const keep = createTeam(db, { workspaceId: "ws1", name: "Sync" });
    const drop = createTeam(db, { workspaceId: "ws1", name: "Sync team" });
    addMember(db, { teamId: drop.id, personId: ana.id, role: "Tech lead" });
    expect(mergeTeams(db, keep.id, drop.id).id).toBe(keep.id);
    expect(getTeam(db, drop.id)).toBeNull();
    expect(listTeamMemberships(db, keep.id).map((m) => [m.personId, m.role])).toEqual([[ana.id, "Tech lead"]]);
  });

  it("merges two people inside one outer transaction, and rolls the whole thing back if it throws", () => {
    const { db } = setup();
    const a = createPerson(db, { workspaceId: "ws1", name: "Sam" });
    const b = createPerson(db, { workspaceId: "ws1", name: "Sam Whitfield" });
    const team = createTeam(db, { workspaceId: "ws1", name: "Sync" });
    addMember(db, { teamId: team.id, personId: a.id });
    expect(() => db.transaction(() => { mergePeople(db, b.id, a.id); throw new Error("later step failed"); })()).toThrow("later step failed");
    expect(getPerson(db, a.id)).not.toBeNull();
    db.transaction(() => { mergePeople(db, b.id, a.id); })();
    expect(getPerson(db, a.id)).toBeNull();
    expect(getPerson(db, b.id)?.aliases).toContain("Sam");
    expect(listTeamMemberships(db, team.id).map((m) => m.personId)).toEqual([b.id]);
  });
});
