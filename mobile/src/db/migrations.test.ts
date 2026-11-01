/** runMigrations: version stamping, and each step commits with its stamp. */
import { describe, it, expect } from "vitest";
import type * as SQLite from "expo-sqlite";
import { runMigrations, MOBILE_SCHEMA_VERSION } from "./migrations";

/** Minimal stand-in for an expo-sqlite handle: tracks user_version and models
 * a transaction as "stamps inside it only stick if the body didn't throw". */
function fakeDb(startVersion: number, opts: { failOnSql?: RegExp } = {}) {
  let version = startVersion;
  const executed: string[] = [];
  const stampsOutsideTx: number[] = [];
  let txDepth = 0;
  let pendingVersion: number | null = null;
  const db = {
    getFirstSync: (sql: string) => {
      if (sql.includes("PRAGMA user_version")) return { user_version: version };
      return null;
    },
    getAllSync: () => [],
    execSync: (sql: string) => {
      if (opts.failOnSql?.test(sql)) throw new Error("boom");
      const m = /PRAGMA user_version = (\d+)/.exec(sql);
      if (m) {
        if (txDepth > 0) pendingVersion = Number(m[1]);
        else {
          version = Number(m[1]);
          stampsOutsideTx.push(version);
        }
        return;
      }
      executed.push(sql);
    },
    withTransactionSync: (fn: () => void) => {
      txDepth++;
      pendingVersion = null;
      try {
        fn();
        if (pendingVersion != null) version = pendingVersion;
      } finally {
        pendingVersion = null;
        txDepth--;
      }
    },
  };
  return { db: db as unknown as SQLite.SQLiteDatabase, version: () => version, executed, stampsOutsideTx };
}

describe("runMigrations", () => {
  it("stamps a brand-new DB at the latest version without running back-migrations", () => {
    const f = fakeDb(0);
    runMigrations(f.db);
    expect(f.version()).toBe(MOBILE_SCHEMA_VERSION);
    expect(f.executed).toHaveLength(0);
  });

  it("upgrades an old install step by step to the latest version", () => {
    const f = fakeDb(1);
    runMigrations(f.db);
    expect(f.version()).toBe(MOBILE_SCHEMA_VERSION);
    expect(f.executed.length).toBeGreaterThan(0);
    // Every step's version stamp commits with its migration, never on its own.
    expect(f.stampsOutsideTx).toEqual([]);
  });

  it("is a no-op when already current", () => {
    const f = fakeDb(MOBILE_SCHEMA_VERSION);
    runMigrations(f.db);
    expect(f.version()).toBe(MOBILE_SCHEMA_VERSION);
    expect(f.executed).toHaveLength(0);
  });

  it("leaves the version at the last good step when a migration throws", () => {
    // v2 creates note_embeddings; make it fail and check nothing past v1 is stamped.
    const f = fakeDb(1, { failOnSql: /note_embeddings/ });
    expect(() => runMigrations(f.db)).toThrow("boom");
    expect(f.version()).toBe(1);
  });
});
