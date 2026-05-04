/**
 * T31 — Tests for agent IPC layer: DB queries, migrations, security validation.
 *
 * Covers:
 *  - Migration v9 (coding_agents) and v10 (code_directory) are idempotent
 *  - getCodingAgents / saveCodingAgent / deleteCodingAgent round-trip
 *  - setDefaultCodingAgent atomically clears other defaults
 *  - setProjectCodeDirectory persists and clears correctly
 *  - isSafePath rejects shell metacharacters and accepts valid absolute paths
 */

import { describe, it, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import {
  getCodingAgents,
  saveCodingAgent,
  deleteCodingAgent,
  setDefaultCodingAgent,
  getCodingAgentById,
  setProjectCodeDirectory,
  createWorkspace,
  createProject,
  getProjectById,
} from "../db/queries";
import { isSafePath } from "./agent";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

function seedWorkspaceAndProject(db: Database.Database) {
  createWorkspace(db, { id: "ws1", name: "Workspace" });
  createProject(db, { id: "proj1", workspaceId: "ws1", name: "Project" });
}

function makeAgent(overrides: Partial<{
  id: string; name: string; binaryPath: string; args: string; isDefault: boolean;
}> = {}) {
  return {
    id: overrides.id ?? "agent1",
    name: overrides.name ?? "OpenCode",
    binaryPath: overrides.binaryPath ?? "/usr/local/bin/opencode",
    args: overrides.args ?? "",
    isDefault: overrides.isDefault ?? false,
  };
}

// ── Migration idempotency ─────────────────────────────────────────────────────

describe("migrations v9 + v10 — idempotency", () => {
  it("applying the schema twice does not throw", () => {
    const db = new BetterSqlite3(":memory:");
    // First application
    expect(() => applySchema(db)).not.toThrow();
    // Second application — migrations track user_version and skip already-run ones
    expect(() => applySchema(db)).not.toThrow();
  });

  it("coding_agents table exists after migration", () => {
    const db = makeDb();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coding_agents'").all()
    ) as { name: string }[];
    expect(tables).toHaveLength(1);
  });

  it("projects.code_directory column exists after migration", () => {
    const db = makeDb();
    const cols = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "code_directory")).toBe(true);
  });

  it("running migrations on a fully migrated DB is a no-op (user_version unchanged)", () => {
    const db = makeDb();
    const vBefore = db.pragma("user_version", { simple: true }) as number;
    applySchema(db);
    const vAfter = db.pragma("user_version", { simple: true }) as number;
    expect(vAfter).toBe(vBefore);
  });
});

// ── getCodingAgents / saveCodingAgent ─────────────────────────────────────────

describe("saveCodingAgent + getCodingAgents", () => {
  it("inserts and retrieves an agent", () => {
    const db = makeDb();
    saveCodingAgent(db, makeAgent());
    const agents = getCodingAgents(db);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("OpenCode");
    expect(agents[0].binaryPath).toBe("/usr/local/bin/opencode");
    expect(agents[0].isDefault).toBe(false);
  });

  it("upserts on duplicate id", () => {
    const db = makeDb();
    saveCodingAgent(db, makeAgent({ name: "Old Name" }));
    saveCodingAgent(db, makeAgent({ name: "New Name" }));
    const agents = getCodingAgents(db);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("New Name");
  });

  it("getCodingAgentById returns null for unknown id", () => {
    const db = makeDb();
    expect(getCodingAgentById(db, "nonexistent")).toBeNull();
  });

  it("stores isDefault flag correctly", () => {
    const db = makeDb();
    saveCodingAgent(db, makeAgent({ isDefault: true }));
    const agent = getCodingAgentById(db, "agent1");
    expect(agent?.isDefault).toBe(true);
  });
});

// ── deleteCodingAgent ─────────────────────────────────────────────────────────

describe("deleteCodingAgent", () => {
  it("removes the agent from the table", () => {
    const db = makeDb();
    saveCodingAgent(db, makeAgent());
    deleteCodingAgent(db, "agent1");
    expect(getCodingAgents(db)).toHaveLength(0);
  });

  it("deleting a non-existent agent does not throw", () => {
    const db = makeDb();
    expect(() => deleteCodingAgent(db, "ghost")).not.toThrow();
  });
});

// ── setDefaultCodingAgent — atomic default swap ───────────────────────────────

describe("setDefaultCodingAgent", () => {
  it("sets the target as default and clears all others atomically", () => {
    const db = makeDb();
    saveCodingAgent(db, makeAgent({ id: "a1", name: "Agent A", isDefault: true }));
    saveCodingAgent(db, makeAgent({ id: "a2", name: "Agent B", isDefault: false }));

    setDefaultCodingAgent(db, "a2");

    const a1 = getCodingAgentById(db, "a1");
    const a2 = getCodingAgentById(db, "a2");
    expect(a1?.isDefault).toBe(false);
    expect(a2?.isDefault).toBe(true);
  });

  it("only one agent is default after multiple setDefault calls", () => {
    const db = makeDb();
    saveCodingAgent(db, makeAgent({ id: "a1", name: "A" }));
    saveCodingAgent(db, makeAgent({ id: "a2", name: "B" }));
    saveCodingAgent(db, makeAgent({ id: "a3", name: "C" }));

    setDefaultCodingAgent(db, "a1");
    setDefaultCodingAgent(db, "a3");

    const defaults = getCodingAgents(db).filter((a) => a.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe("a3");
  });

  it("setting the current default again keeps it as default", () => {
    const db = makeDb();
    saveCodingAgent(db, makeAgent({ id: "a1", isDefault: true }));
    setDefaultCodingAgent(db, "a1");
    expect(getCodingAgentById(db, "a1")?.isDefault).toBe(true);
  });
});

// ── setProjectCodeDirectory ───────────────────────────────────────────────────

describe("setProjectCodeDirectory", () => {
  it("persists a directory path on the project row", () => {
    const db = makeDb();
    seedWorkspaceAndProject(db);
    setProjectCodeDirectory(db, "proj1", "/code/my-project");
    const proj = getProjectById(db, "proj1");
    expect(proj?.codeDirectory).toBe("/code/my-project");
  });

  it("clears the directory when passed null", () => {
    const db = makeDb();
    seedWorkspaceAndProject(db);
    setProjectCodeDirectory(db, "proj1", "/code/my-project");
    setProjectCodeDirectory(db, "proj1", null);
    const proj = getProjectById(db, "proj1");
    expect(proj?.codeDirectory).toBeNull();
  });

  it("new projects have codeDirectory = null by default", () => {
    const db = makeDb();
    seedWorkspaceAndProject(db);
    const proj = getProjectById(db, "proj1");
    expect(proj?.codeDirectory).toBeNull();
  });
});

// ── isSafePath — security validation ─────────────────────────────────────────

describe("isSafePath", () => {
  // Valid paths
  it("accepts a standard Unix absolute path", () => {
    expect(isSafePath("/usr/local/bin/opencode")).toBe(true);
  });

  it("accepts a path with hyphens and dots", () => {
    expect(isSafePath("/home/user/.local/bin/my-agent")).toBe(true);
  });

  it("accepts a Windows absolute path", () => {
    expect(isSafePath("C:\\Users\\gerard\\AppData\\Local\\opencode.exe")).toBe(true);
  });

  // Metacharacter injection attempts
  it("rejects semicolon", () => {
    expect(isSafePath("/usr/bin/opencode; rm -rf /")).toBe(false);
  });

  it("rejects pipe", () => {
    expect(isSafePath("/usr/bin/opencode | cat /etc/passwd")).toBe(false);
  });

  it("rejects ampersand", () => {
    expect(isSafePath("/usr/bin/opencode && evil")).toBe(false);
  });

  it("rejects backtick", () => {
    expect(isSafePath("/usr/bin/opencode`whoami`")).toBe(false);
  });

  it("rejects dollar sign", () => {
    expect(isSafePath("/usr/bin/$SHELL")).toBe(false);
  });

  it("rejects single quote", () => {
    expect(isSafePath("/usr/bin/open'code")).toBe(false);
  });

  it("rejects double quote", () => {
    expect(isSafePath('/usr/bin/open"code')).toBe(false);
  });

  it("rejects glob wildcard *", () => {
    expect(isSafePath("/usr/bin/*")).toBe(false);
  });

  it("rejects relative path", () => {
    expect(isSafePath("../bin/opencode")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isSafePath("")).toBe(false);
  });
});
