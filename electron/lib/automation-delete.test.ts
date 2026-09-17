/**
 * deleteAutomationWithCleanup — retry-safe ordering (issue #133).
 *
 * The DB row is the only handle back to an automation's folder + keychain
 * secrets, so both cleanups must succeed BEFORE the row is removed. A cleanup
 * failure throws and keeps the row, making a later delete a clean retry.
 */

import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject } from "../db/queries";
import {
  createAutomation,
  getAutomationById,
  type AutomationInput,
} from "../db/automation-queries";
import { automationFolderDir } from "./automation-folder";
import { deleteAutomationWithCleanup } from "./automation-delete";

let db: Database.Database;
let wsId: string;
let projectId: string;
let workspacePath: string;

function makeInput(overrides: Partial<AutomationInput> = {}): AutomationInput {
  return {
    workspaceId: wsId,
    projectId,
    name: "Weekly review",
    instructions: "Do the thing.",
    scheduleKind: "every",
    scheduleExpr: "every 24 hours",
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  db = new BetterSqlite3(":memory:");
  applySchema(db);
  wsId = "ws-1";
  projectId = "proj-1";
  createWorkspace(db, { id: wsId, name: "Workspace" });
  createProject(db, { id: projectId, workspaceId: wsId, name: "Project" });
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "automation-delete-"));
});

describe("deleteAutomationWithCleanup", () => {
  it("returns ok:false for a missing automation without touching anything", () => {
    let purged = 0;
    let removed = 0;
    const res = deleteAutomationWithCleanup(db, workspacePath, "nope", {
      purgeSecrets: () => { purged++; },
      removeDir: () => { removed++; return true; },
    });
    expect(res).toEqual({ ok: false, deleted: false });
    expect(purged).toBe(0);
    expect(removed).toBe(0);
  });

  it("purges secrets, removes the folder, then deletes the row (happy path)", () => {
    const a = createAutomation(db, makeInput());
    const folder = automationFolderDir(workspacePath, a.id, "Project");
    fs.mkdirSync(path.join(folder, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(folder, "manifest.json"), "{}");

    const calls: string[] = [];
    const res = deleteAutomationWithCleanup(db, workspacePath, a.id, {
      projectNameFor: () => "Project",
      purgeSecrets: () => { calls.push("purge"); },
      removeDir: (dir) => {
        calls.push("remove");
        expect(dir).toBe(folder);
        fs.rmSync(dir, { recursive: true, force: true });
        return !fs.existsSync(dir);
      },
    });

    expect(res).toEqual({ ok: true, deleted: true });
    expect(calls).toEqual(["purge", "remove"]); // secrets before folder, both before row
    expect(getAutomationById(db, a.id)).toBeNull();
    expect(fs.existsSync(folder)).toBe(false);
  });

  it("keeps the row when secret purge fails (retry possible)", () => {
    const a = createAutomation(db, makeInput());
    let removed = false;
    expect(() =>
      deleteAutomationWithCleanup(db, workspacePath, a.id, {
        purgeSecrets: () => { throw new Error("keychain locked"); },
        removeDir: () => { removed = true; return true; },
      }),
    ).toThrow("keychain locked");
    expect(removed).toBe(false); // folder removal never attempted
    expect(getAutomationById(db, a.id)).not.toBeNull(); // row kept → retry works
  });

  it("keeps the row when folder removal fails (retry possible)", () => {
    const a = createAutomation(db, makeInput());
    let purged = false;
    expect(() =>
      deleteAutomationWithCleanup(db, workspacePath, a.id, {
        purgeSecrets: () => { purged = true; },
        removeDir: () => false, // e.g. permissions / open handle
      }),
    ).toThrow("failed to remove automation folder");
    expect(purged).toBe(true);
    expect(getAutomationById(db, a.id)).not.toBeNull(); // row kept → retry works
  });

  it("keeps the row when folder removal throws", () => {
    const a = createAutomation(db, makeInput());
    expect(() =>
      deleteAutomationWithCleanup(db, workspacePath, a.id, {
        purgeSecrets: () => {},
        removeDir: () => { throw new Error("EBUSY"); },
      }),
    ).toThrow("failed to remove automation folder");
    expect(getAutomationById(db, a.id)).not.toBeNull();
  });
});
