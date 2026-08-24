/**
 * Cairn — archive-and-drop unit tests for the pre-Cordis transcript tables.
 *
 * These guard the data-integrity claim in migration v49: EXISTING users
 * upgrading from 2.7.6 must NOT lose their chat/pi-agent history silently.
 * Rows go to `<db-dir>/.cairn/archive/2.7.7/<table>-<ts>.ndjson` first, then
 * the tables are DROPped. Fresh installs (empty tables) skip the dump but
 * still drop the tables.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";
import { archiveAndDropLegacyTranscripts, formatArchiveNotice } from "./legacy-transcript-archive";

function newTmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-archive-test-"));
  const dbPath = path.join(dir, "cairn.db");
  const db = new Database(dbPath);
  return { db, dir, dbPath };
}

describe("archiveAndDropLegacyTranscripts", () => {
  it("archives non-empty tables to NDJSON, then DROPs them", () => {
    const { db, dir } = newTmpDb();
    db.exec(`
      CREATE TABLE chat_messages (id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, created_at TEXT);
      CREATE TABLE pi_agent_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp TEXT);
    `);
    db.prepare("INSERT INTO chat_messages VALUES (?,?,?,?,?)").run("m1", "t1", "user", "hello", "2026-08-23T00:00:00Z");
    db.prepare("INSERT INTO chat_messages VALUES (?,?,?,?,?)").run("m2", "t1", "assistant", "hi there", "2026-08-23T00:00:01Z");
    db.prepare("INSERT INTO pi_agent_messages VALUES (?,?,?,?,?)").run("p1", "s1", "user", "run tests", "2026-08-23T00:00:02Z");

    const result = archiveAndDropLegacyTranscripts(db);

    expect(result.archivedTables).toHaveLength(2);
    expect(result.archivedTables.find((e) => e.table === "chat_messages")?.rows).toBe(2);
    expect(result.archivedTables.find((e) => e.table === "pi_agent_messages")?.rows).toBe(1);
    expect(result.droppedTables).toEqual(["chat_messages", "pi_agent_messages"]);

    // Tables are gone.
    const remaining = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chat_messages','pi_agent_messages')").all();
    expect(remaining).toHaveLength(0);

    // NDJSON dumps exist and round-trip.
    const archiveDir = path.join(dir, ".cairn", "archive", "2.7.7");
    const files = fs.readdirSync(archiveDir);
    expect(files.some((f) => f.startsWith("chat_messages-"))).toBe(true);
    expect(files.some((f) => f.startsWith("pi_agent_messages-"))).toBe(true);

    const chatDump = fs.readFileSync(path.join(archiveDir, files.find((f) => f.startsWith("chat_messages-"))!), "utf8");
    const chatRows = chatDump.trim().split("\n").map((l) => JSON.parse(l));
    expect(chatRows).toHaveLength(2);
    expect(chatRows[0]).toMatchObject({ id: "m1", role: "user", content: "hello" });

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op on a fresh install (tables absent) — DROPs nothing, archives nothing", () => {
    const { db, dir } = newTmpDb();
    // No CREATE TABLE at all.
    const result = archiveAndDropLegacyTranscripts(db);
    expect(result.archivedTables).toEqual([]);
    expect(result.droppedTables).toEqual([]);
    // Archive dir should NOT be created when there's nothing to write.
    expect(fs.existsSync(path.join(dir, ".cairn", "archive"))).toBe(false);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("DROPs an empty legacy table but writes no dump file", () => {
    const { db, dir } = newTmpDb();
    db.exec("CREATE TABLE approval_items (id TEXT PRIMARY KEY, state TEXT);");
    const result = archiveAndDropLegacyTranscripts(db);
    expect(result.archivedTables).toEqual([]);
    expect(result.droppedTables).toEqual(["approval_items"]);
    expect(fs.existsSync(path.join(dir, ".cairn", "archive"))).toBe(false);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is idempotent — a second run after tables are gone does nothing", () => {
    const { db, dir } = newTmpDb();
    db.exec("CREATE TABLE chat_messages (id TEXT PRIMARY KEY, content TEXT);");
    db.prepare("INSERT INTO chat_messages VALUES (?,?)").run("m1", "hello");

    const first = archiveAndDropLegacyTranscripts(db);
    expect(first.archivedTables).toHaveLength(1);
    expect(first.droppedTables).toEqual(["chat_messages"]);

    // Second run: table no longer exists.
    const second = archiveAndDropLegacyTranscripts(db);
    expect(second.archivedTables).toEqual([]);
    expect(second.droppedTables).toEqual([]);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("formatArchiveNotice returns null on empty result, a summary otherwise", () => {
    expect(formatArchiveNotice({ archivedTables: [], droppedTables: [], archiveDir: null })).toBeNull();
    const s = formatArchiveNotice({
      archivedTables: [
        { table: "chat_messages", rows: 42, path: "/x/y/chat_messages-t.ndjson" },
        { table: "pi_agent_messages", rows: 7, path: "/x/y/pi_agent_messages-t.ndjson" },
      ],
      droppedTables: ["chat_messages", "pi_agent_messages"],
      archiveDir: "/x/y",
    });
    expect(s).toContain("49 rows");
    expect(s).toContain("chat_messages (42)");
    expect(s).toContain("pi_agent_messages (7)");
    expect(s).toContain("/x/y");
  });

  it(":memory: DB is safe (no archive dir), still drops the tables", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE chat_messages (id TEXT PRIMARY KEY, content TEXT);");
    db.prepare("INSERT INTO chat_messages VALUES (?,?)").run("m1", "hello");

    const result = archiveAndDropLegacyTranscripts(db);
    // No archive file because dbPath is ':memory:', but table is still dropped.
    expect(result.archivedTables).toEqual([]);
    expect(result.droppedTables).toEqual(["chat_messages"]);
    db.close();
  });
});
