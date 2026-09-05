/**
 * Unit tests for the shared node-pty session manager (`pty-sessions.ts`).
 *
 * Fake spawn substrate (the native binding is never loaded); real
 * `:memory:` database for the project-boundary check. Proves: path safety,
 * cwd confinement, shell spawn registration, write/resize routing, data/exit
 * subscriptions, and idempotent kill.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject, setProjectCodeDirectory } from "../db/queries";
import {
  __clearPtySessionsForTest,
  __setPtySpawnForTest,
  assertWithinCodeDirectory,
  getPtySession,
  hasPtySession,
  isSafePath,
  killPtySession,
  onPtySessionData,
  onPtySessionExit,
  resizePtySession,
  spawnShellPty,
  writePtySession,
  type PtyHandle,
  type PtySpawnOptions,
} from "./pty-sessions";

interface FakePty extends PtyHandle {
  writes: string[];
  kills: string[];
  resizes: Array<[number, number]>;
  fireData(data: string): void;
  fireExit(exitCode: number): void;
}

function makeFakePty(pid = 4242): FakePty {
  const dataCbs: Array<(data: string) => void> = [];
  const exitCbs: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  const fake: FakePty = {
    pid,
    writes: [],
    kills: [],
    resizes: [],
    onData: (cb) => {
      dataCbs.push(cb);
      return { dispose: () => { dataCbs.splice(dataCbs.indexOf(cb), 1); } };
    },
    onExit: (cb) => {
      exitCbs.push(cb);
      return { dispose: () => { exitCbs.splice(exitCbs.indexOf(cb), 1); } };
    },
    write: (data: string) => { fake.writes.push(data); },
    resize: (cols: number, rows: number) => { fake.resizes.push([cols, rows]); },
    kill: (signal?: string) => {
      fake.kills.push(signal ?? "<default>");
      for (const cb of [...exitCbs]) cb({ exitCode: 0 });
    },
    fireData: (data: string) => { for (const cb of [...dataCbs]) cb(data); },
    fireExit: (exitCode: number) => { for (const cb of [...exitCbs]) cb({ exitCode }); },
  };
  return fake;
}

function makeFakeSpawn() {
  const spawned: Array<{ file: string; args: string[]; cwd: string }> = [];
  const fakes: FakePty[] = [];
  const fn = (file: string, args: string[], opts: PtySpawnOptions): PtyHandle => {
    const fake = makeFakePty(5000 + fakes.length);
    spawned.push({ file, args, cwd: opts.cwd });
    fakes.push(fake);
    return fake;
  };
  return { spawned, fakes, fn };
}

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

function seedCodeDir(db: Database.Database, codeDir: string): void {
  createWorkspace(db, { id: "ws1", name: "Workspace" });
  createProject(db, { id: "proj1", workspaceId: "ws1", name: "Project" });
  setProjectCodeDirectory(db, "proj1", codeDir);
}

let codeDir: string;
let outsideDir: string;
let db: Database.Database;

beforeEach(async () => {
  codeDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), "cairn-pty-code-")));
  outsideDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), "cairn-pty-out-")));
  db = makeDb();
  seedCodeDir(db, codeDir);
  __setPtySpawnForTest(undefined);
  __clearPtySessionsForTest();
});

afterEach(() => {
  __setPtySpawnForTest(undefined);
  __clearPtySessionsForTest();
  db.close();
  fs.rmSync(codeDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe("pty-sessions", () => {
  it("rejects unsafe paths and accepts absolute ones", () => {
    expect(isSafePath("/usr/local/bin/agent")).toBe(true);
    expect(isSafePath("/bin/evil; rm -rf /")).toBe(false);
    expect(isSafePath("/bin/evil | cat")).toBe(false);
  });

  it("confines cwd to registered code directories", async () => {
    await expect(assertWithinCodeDirectory(db, codeDir)).resolves.toBe(codeDir);
    await expect(assertWithinCodeDirectory(db, outsideDir)).rejects.toThrow("outside any registered");
    await expect(assertWithinCodeDirectory(db, "/tmp/evil; id")).rejects.toThrow("Unsafe path");
  });

  it("spawns a shell session in the shared table", async () => {
    const fake = makeFakeSpawn();
    __setPtySpawnForTest(fake.fn);
    const { sessionId, cwd } = await spawnShellPty(db, codeDir);
    expect(cwd).toBe(codeDir);
    expect(fake.spawned).toHaveLength(1);
    expect(fake.spawned[0]?.cwd).toBe(codeDir);
    expect(hasPtySession(sessionId)).toBe(true);
    expect(getPtySession(sessionId)?.kind).toBe("shell");
  });

  it("refuses spawn outside code directories (fail closed)", async () => {
    const fake = makeFakeSpawn();
    __setPtySpawnForTest(fake.fn);
    await expect(spawnShellPty(db, outsideDir)).rejects.toThrow("outside any registered");
    expect(fake.spawned).toHaveLength(0);
  });

  it("routes write/resize/data/exit and kills idempotently", async () => {
    const fake = makeFakeSpawn();
    __setPtySpawnForTest(fake.fn);
    const { sessionId } = await spawnShellPty(db, codeDir);
    const pty = fake.fakes[0];
    if (!pty) throw new Error("fake PTY was not spawned");

    writePtySession(sessionId, "echo hi\r");
    resizePtySession(sessionId, 80, 24);
    expect(pty.writes).toEqual(["echo hi\r"]);
    expect(pty.resizes).toEqual([[80, 24]]);

    const seen: string[] = [];
    const disposeData = onPtySessionData(sessionId, (data) => seen.push(data));
    pty.fireData("hi\n");
    expect(seen).toEqual(["hi\n"]);
    disposeData();
    pty.fireData("again\n");
    expect(seen).toEqual(["hi\n"]);

    let exitCode = -1;
    onPtySessionExit(sessionId, (e) => { exitCode = e.exitCode; });
    killPtySession(sessionId);
    expect(pty.kills).toHaveLength(1);
    expect(exitCode).toBe(0);
    expect(hasPtySession(sessionId)).toBe(false);

    // Idempotent + fail-soft on unknown ids (matches the old IPC behaviour).
    expect(() => killPtySession(sessionId)).not.toThrow();
    expect(() => killPtySession("missing")).not.toThrow();
    expect(() => writePtySession("missing", "x")).not.toThrow();
    expect(() => resizePtySession("missing", 80, 24)).not.toThrow();
    expect(onPtySessionData("missing", () => {})).toBeTypeOf("function");
  });
});
