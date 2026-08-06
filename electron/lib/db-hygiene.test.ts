/**
 * Unit tests for electron/lib/db-hygiene.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import { freePageRatio, reclaimFreeSpace, materializeIncrementalVacuum, runStartupHygiene } from "./db-hygiene";

describe("db-hygiene", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    applySchema(db);
  });

  it("reports a 0 free-page ratio on an empty DB", () => {
    expect(freePageRatio(db)).toBe(0);
  });

  it("materialises incremental auto-vacuum with a one-time VACUUM", () => {
    // A DB that already has content (applySchema created tables) reads 0 until
    // VACUUMed — exactly the "existing install" case.
    expect(db.pragma("auto_vacuum", { simple: true })).toBe(0);
    expect(materializeIncrementalVacuum(db)).toBe(true);
    expect(db.pragma("auto_vacuum", { simple: true })).toBe(2);
    // Already active → no-op, returns false.
    expect(materializeIncrementalVacuum(db)).toBe(false);
  });

  it("drains the freelist after delete churn once the mode is materialised", () => {
    materializeIncrementalVacuum(db);
    db.exec("CREATE TABLE churn(x BLOB)");
    const ins = db.prepare("INSERT INTO churn VALUES (randomblob(4000))");
    for (let i = 0; i < 300; i++) ins.run();
    db.exec("DELETE FROM churn");

    const before = freePageRatio(db);
    expect(before).toBeGreaterThan(0);

    reclaimFreeSpace(db);
    expect(freePageRatio(db)).toBeLessThan(before);
  });

  it("reclaimFreeSpace is a harmless no-op before materialisation", () => {
    // Without materialising, incremental_vacuum is inert — must never throw.
    db.exec("CREATE TABLE churn(x BLOB)");
    const ins = db.prepare("INSERT INTO churn VALUES (randomblob(4000))");
    for (let i = 0; i < 100; i++) ins.run();
    db.exec("DELETE FROM churn");
    expect(() => reclaimFreeSpace(db)).not.toThrow();
  });

  it("runStartupHygiene does not throw and keeps the periodic path safe", () => {
    expect(() => runStartupHygiene(db)).not.toThrow();
    // Timers are unref'd; a second call re-arms without error (workspace switch).
    expect(() => runStartupHygiene(db)).not.toThrow();
  });
});
