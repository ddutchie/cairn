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

import { __isWriteChannel as isWriteChannel } from "./registry";

describe("isWriteChannel", () => {
  it("treats non-db channels as non-writes (they never broadcast db:changed)", () => {
    for (const c of ["app:setTheme", "git:status", "chat:stream", "updater:install"]) {
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
      "db:chat:addMessage",
      "db:chat:upsertThread",
      "db:chat:deleteThread",
      "db:chat:clearThreadMessages",
      "db:project:updateSettings",
      "db:piSession:saveMessages",
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
      "db:piSession:list",
      "db:piSession:messages",
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
