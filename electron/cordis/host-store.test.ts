/**
 * host-store.test — proves each HostStore seam method delegates to the real
 * app implementation (same queries, same lib functions) using a real
 * in-memory SQLite db + applySchema. No live model, no network.
 *
 * Not covered here (deliberately):
 *  - ensureLocalLlmPort — spawns / probes the on-device llama-server process;
 *    covered by electron/lib/llama-server.test.ts.
 *  - Pure re-exports (TOOL_SCHEMAS, buildSystemPrompt, …) — asserted defined
 *    only; their behaviour is owned by their home modules' tests.
 */
import { describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import {
  createWorkspace,
  createProject,
  createNote,
  createColumn,
  createCard,
  createCodingSession,
  getCodingSessionById,
  getSessionProfile,
  getSessionTodos,
} from "../db/queries";
import {
  CAIRN_DB,
  CAIRN_HOST,
  createHostStore,
  getHostStore,
  getGitBranch,
  runWorkspaceHygiene,
  isScheduleEnabled,
  recordUsage,
  newId,
  buildSystemPrompt,
  TOOL_SCHEMAS,
  TOOL_LABELS,
  dlog,
} from "./host-store";

function openDb(): Database.Database {
  const db: Database.Database = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

function seedWorkspace(db: Database.Database) {
  createWorkspace(db, { id: "ws-1", name: "Workspace One" });
  createProject(db, { id: "proj-1", workspaceId: "ws-1", name: "Project One", description: "Desc One" });
  createNote(db, { id: "note-1", projectId: "proj-1", workspaceId: "ws-1", title: "Note One", content: "hello content" });
  createColumn(db, { id: "col-1", projectId: "proj-1", workspaceId: "ws-1", name: "Todo" });
  createCard(db, { id: "card-1", columnId: "col-1", projectId: "proj-1", workspaceId: "ws-1", title: "Card One" });
}

describe("host-store seam delegation", () => {
  it("getWorkspaceMeta returns workspace/project names + description", () => {
    const db = openDb();
    try {
      seedWorkspace(db);
      const host = createHostStore(db);
      expect(host.getWorkspaceMeta("ws-1", "proj-1")).toEqual({
        workspaceName: "Workspace One",
        projectName: "Project One",
        projectDescription: "Desc One",
      });
      expect(host.getWorkspaceMeta(undefined, undefined)).toEqual({
        workspaceName: undefined,
        projectName: undefined,
        projectDescription: undefined,
      });
      expect(host.getWorkspaceMeta("missing", "missing")).toEqual({
        workspaceName: undefined,
        projectName: undefined,
        projectDescription: undefined,
      });
    } finally {
      db.close();
    }
  });

  it("readNoteContent returns content, undefined for unknown ids", () => {
    const db = openDb();
    try {
      seedWorkspace(db);
      const host = createHostStore(db);
      expect(host.readNoteContent("note-1")).toBe("hello content");
      expect(host.readNoteContent("nope")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("indexChatThread persists the thread index row", () => {
    const db = openDb();
    try {
      seedWorkspace(db);
      createHostStore(db).indexChatThread("thread-1", "ws-1", "proj-1");
      const row = db.prepare("SELECT id, workspace_id, project_id FROM chat_threads WHERE id = ?").get("thread-1") as
        | { id: string; workspace_id: string; project_id: string }
        | undefined;
      expect(row).toMatchObject({ id: "thread-1", workspace_id: "ws-1", project_id: "proj-1" });
    } finally {
      db.close();
    }
  });

  it("upsertSessionProfile persists the profile row", () => {
    const db = openDb();
    try {
      createHostStore(db).upsertSessionProfile("sess-1", "coding", {
        cwd: "/w",
        workspaceId: "ws-1",
        projectId: "proj-1",
      });
      expect(getSessionProfile(db, "sess-1")).toMatchObject({
        sessionId: "sess-1",
        profile: "coding",
        cwd: "/w",
        workspaceId: "ws-1",
        projectId: "proj-1",
      });
    } finally {
      db.close();
    }
  });

  it("save/getSessionTodos round-trips", () => {
    const db = openDb();
    try {
      seedWorkspace(db);
      createCodingSession(db, {
        id: "sess-1",
        projectId: "proj-1",
        taskTitle: "t",
        cwd: "/w",
        mode: "execute",
        spawnedAt: new Date().toISOString(),
      });
      const host = createHostStore(db);
      host.saveSessionTodos("sess-1", [{ content: "do it", status: "pending", priority: "medium" }]);
      expect(host.getSessionTodos("sess-1")).toEqual([
        { content: "do it", status: "pending", priority: "medium" },
      ]);
      expect(getSessionTodos(db, "sess-1")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("updateCodingPlan persists plan content on an existing session", () => {
    const db = openDb();
    try {
      seedWorkspace(db);
      createCodingSession(db, {
        id: "sess-1",
        projectId: "proj-1",
        taskTitle: "t",
        cwd: "/w",
        mode: "plan",
        spawnedAt: new Date().toISOString(),
      });
      createHostStore(db).updateCodingPlan("sess-1", "# plan");
      expect(getCodingSessionById(db, "sess-1")?.planContent).toBe("# plan");
    } finally {
      db.close();
    }
  });

  it("workspace approval grants round-trip", () => {
    const db = openDb();
    try {
      const host = createHostStore(db);
      expect(host.isWorkspaceGranted("ws-1", "read")).toBe(false);
      host.addWorkspaceApprovalGrant("ws-1", "read", null);
      expect(host.isWorkspaceGranted("ws-1", "read")).toBe(true);
      expect(host.isWorkspaceGranted("ws-1", "read", "other")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("tool-executor services delegate (snapshot, lookup, updates, style)", () => {
    const db = openDb();
    try {
      seedWorkspace(db);
      const host = createHostStore(db);
      const snap = host.getFullSnapshot() as { notes: unknown[]; cards: unknown[] };
      expect(snap.notes.length).toBeGreaterThan(0);
      expect(snap.cards.length).toBeGreaterThan(0);
      expect(host.findLiveNoteByTitle("proj-1", "Note One")?.id).toBe("note-1");
      expect(host.updateNote("note-1", { title: "Note Renamed" }).title).toBe("Note Renamed");
      expect(host.updateCard("card-1", { title: "Card Renamed" }).title).toBe("Card Renamed");
      expect(host.getUserStyle()).toBeNull();
      const appended = host.appendUserStyleObservation(undefined, "Prefer short sentences.");
      expect(appended.updated).toBe(true);
      expect(host.getUserStyle()).not.toBeNull();
      expect(host.executeReadTool(snap as never, "definitely-not-a-tool", {})).toEqual({ handled: false });
    } finally {
      db.close();
    }
  });

  it("generatePrd short-circuits on unknown projects without touching the LLM", async () => {
    const db = openDb();
    try {
      const host = createHostStore(db);
      await expect(
        host.generatePrd("/tmp", { projectId: "missing", title: "T", requirements: "R" }, {} as never),
      ).resolves.toEqual({ error: "Project not found" });
    } finally {
      db.close();
    }
  });

  it("external tools degrade with no servers configured (no network)", async () => {
    const db = openDb();
    try {
      const host = createHostStore(db);
      await expect(host.getExternalToolDefs("ws-1", "proj-1")).resolves.toEqual([]);
      const out = await host.executeExternalTool("ws-1", "proj-1", "definitely-not-a-tool", {});
      expect(typeof out).toBe("string");
      expect(out).toMatch(/not an external tool/i);
    } finally {
      db.close();
    }
  });

  it("recordUsage is a best-effort no-op without an initialised recorder", () => {
    expect(() =>
      recordUsage({ source: "chat", sessionId: "s", model: "m", promptTokens: 1, completionTokens: 1 }),
    ).not.toThrow();
    expect(() =>
      createHostStore(openDb()).recordUsage({ source: "chat", sessionId: "s", model: "m" }),
    ).not.toThrow();
  });

  it("getGitBranch fails closed outside a repo", () => {
    expect(getGitBranch("/definitely/not/a/repo")).toBeUndefined();
    expect(createHostStore(openDb()).getGitBranch("/definitely/not/a/repo")).toBeUndefined();
  });

  it("runWorkspaceHygiene + isScheduleEnabled are safe with empty state", () => {
    const db = openDb();
    try {
      expect(() => runWorkspaceHygiene("/definitely/not/a/workspace")).not.toThrow();
      expect(() => createHostStore(db).runWorkspaceHygiene("/definitely/not/a/workspace")).not.toThrow();
      expect(isScheduleEnabled()).toBe(false);
      expect(createHostStore(db).isScheduleEnabled()).toBe(false);
    } finally {
      db.close();
    }
  });

  it("getHostStore prefers the provided store, falls back to the db handle", () => {
    const db = openDb();
    try {
      const provided = createHostStore(db);
      const calls: Array<[string, unknown]> = [];
      const fakeCtx = {
        get: (key: string) => {
          calls.push([key, undefined]);
          if (key === CAIRN_HOST) return provided;
          if (key === CAIRN_DB) return db;
          return undefined;
        },
      } as never;
      expect(getHostStore(fakeCtx)).toBe(provided);

      const dbOnlyCtx = { get: (key: string) => (key === CAIRN_DB ? db : undefined) } as never;
      const fallback = getHostStore(dbOnlyCtx);
      expect(fallback).toBeDefined();
      expect(fallback?.getSessionTodos("sess-1")).toEqual([]);

      const emptyCtx = { get: () => undefined } as never;
      expect(getHostStore(emptyCtx)).toBeUndefined();
      expect(getHostStore(emptyCtx, db)).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("pure re-exports resolve to the home implementations", () => {
    expect(typeof newId()).toBe("string");
    expect(newId()).not.toBe(newId());
    expect(typeof buildSystemPrompt).toBe("function");
    expect(typeof TOOL_SCHEMAS).toBe("object");
    expect(typeof TOOL_LABELS).toBe("object");
    expect(typeof dlog).toBe("function");
  });
});
