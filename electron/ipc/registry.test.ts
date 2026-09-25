/**
 * Unit tests for the registry's read/write channel classification.
 *
 * `isWriteChannel` decides whether a completed `db:*` channel auto-broadcasts
 * `db:changed` (a full snapshot re-hydration in every window + mobile client).
 * Misclassifying a read as a write causes a silent re-hydration storm, so this
 * guards the convention: reads (by action verb or the small irregular-name set)
 * must never broadcast; everything else `db:*` does.
 */

import { describe, it, expect, vi } from "vitest";

// registry.ts imports `electron` at module load; stub the bits it touches so the
// pure classifier can be imported in the node test environment.
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { __isWriteChannel as isWriteChannel, __classifyChannel as classifyChannel } from "./registry";
import fs from "fs";
import path from "path";

describe("isWriteChannel", () => {
  it("treats read channels with non-verb names as reads (no db:changed storm from polling)", () => {
    for (const ch of [
      "db:automation:runningCount",
      "db:automation:recentRuns",
      "db:automation:runs",
      "db:automation:runLog",
      "db:notification:count",
      "db:session:todos",
      "db:chat:sessionMessages",
      "db:changes:get",
    ]) {
      expect(isWriteChannel(ch), ch).toBe(false);
    }
  });

  it("treats non-db channels as non-writes (they never broadcast db:changed)", () => {
    for (const c of ["app:setTheme", "git:status", "session:prompt", "updater:install"]) {
      expect(isWriteChannel(c)).toBe(false);
    }
  });

  it("classifies write actions as writes", () => {
    const writes = [
      "db:note:create",
      "db:note:update",
      "db:note:delete",
      "db:note:moveToFolder",
      "db:note:moveToProject",
      "db:card:addBlocker",
      "db:card:removeBlocker",
      "db:cards:archive-done",
      "db:chat:upsertThread",
      "db:chat:deleteThread",
      "db:chat:clearThreadMessages",
      "db:project:updateSettings",
      "db:graph:recompute",
      "db:embeddings:reindex",
      "db:embeddings:recomputeProjections",
      "db:flow:node:update",
      "db:flow:node:delete",
      "db:flow:edge:delete",
    ];
    for (const c of writes) expect(isWriteChannel(c)).toBe(true);
  });

  it("classifies read actions as reads (no broadcast)", () => {
    const reads = [
      "db:workspace:list",
      "db:project:list",
      "db:note:list",
      "db:column:list",
      "db:card:list",
      "db:card:ready",
      "db:flow:get",
      "db:graph:get",
      "db:graph:neighbors",
      "db:tag:list",
      "db:chat:threads",
      "db:chat:messages",
      "db:session:list",
      "db:embeddings:search",
    ];
    for (const c of reads) expect(isWriteChannel(c)).toBe(false);
  });

  it("classifies irregularly-named read channels as reads", () => {
    for (const c of ["db:snapshot", "db:hasData", "db:mcpQuery"]) {
      expect(isWriteChannel(c)).toBe(false);
    }
  });

  it("does not broadcast for db:flow:url:fetch — a pure URL-metadata read (regression)", () => {
    // Previously misclassified as a write because it wasn't in the denylist,
    // causing a db:changed re-hydration on every URL preview.
    expect(isWriteChannel("db:flow:url:fetch")).toBe(false);
  });
});

describe("db:* channel classification coverage", () => {
  it("every registered db:* channel is explicitly a read or a write", () => {
    // A db:* channel whose action is neither a known read nor a known write
    // verb defaults to "write" and broadcasts db:changed (→ every window
    // refreshes) on every call. Make new channels choose explicitly: add the
    // action to READ_ACTIONS / WRITE_ACTIONS, or the channel to READ_CHANNELS.
    const root = path.resolve(__dirname, "..");
    const channels = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          for (const m of fs.readFileSync(full, "utf8").matchAll(/registerIpcHandle\(\s*"(db:[^"]+)"/g)) channels.add(m[1]);
        }
      }
    };
    walk(root);
    expect(channels.size).toBeGreaterThan(20);
    const unknown = [...channels].filter((c) => classifyChannel(c) === "unknown");
    expect(unknown).toEqual([]);
  });
});
