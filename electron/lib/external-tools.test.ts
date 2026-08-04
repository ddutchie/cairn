import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";

// external-tools imports mcp-client + custom-services (→ secure-store → electron).
vi.mock("electron", () => ({
  app: { isReady: () => false, getPath: () => "/tmp" },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { resolveAttachedToolIds, isExternalToolName, prettifyToolName, externalToolLabel, filterDisabledMcpDefs, checkRequirements } from "./external-tools";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject, saveMcpServer, saveCustomService, setToolAttachment } from "../db/queries";

describe("external-tools scoping", () => {
  it("collects enabled attachments by type", () => {
    const { mcp, service } = resolveAttachedToolIds([
      { projectId: "p1", toolType: "mcp", toolId: "m1", enabled: true },
      { projectId: "p1", toolType: "service", toolId: "s1", enabled: true },
      { projectId: "p1", toolType: "mcp", toolId: "m2", enabled: true },
    ]);
    expect([...mcp].sort()).toEqual(["m1", "m2"]);
    expect([...service]).toEqual(["s1"]);
  });

  it("merges global + project rows (union of enables)", () => {
    const { mcp } = resolveAttachedToolIds([
      { projectId: "__global__", toolType: "mcp", toolId: "global1", enabled: true },
      { projectId: "p1", toolType: "mcp", toolId: "proj1", enabled: true },
    ]);
    expect([...mcp].sort()).toEqual(["global1", "proj1"]);
  });

  it("an explicit disabled row suppresses a tool even if another row enables it", () => {
    // Global-on but project-off → suppressed.
    const { mcp } = resolveAttachedToolIds([
      { projectId: "__global__", toolType: "mcp", toolId: "m1", enabled: true },
      { projectId: "p1", toolType: "mcp", toolId: "m1", enabled: false },
    ]);
    expect(mcp.has("m1")).toBe(false);
  });

  it("ignores disabled-only rows", () => {
    const { mcp, service } = resolveAttachedToolIds([
      { projectId: "p1", toolType: "mcp", toolId: "m1", enabled: false },
    ]);
    expect(mcp.size).toBe(0);
    expect(service.size).toBe(0);
  });

  it("returns empty sets for no rows", () => {
    const { mcp, service } = resolveAttachedToolIds([]);
    expect(mcp.size).toBe(0);
    expect(service.size).toBe(0);
  });
});

describe("external-tools routing guard", () => {
  it("recognises mcp + svc prefixes, rejects built-ins", () => {
    expect(isExternalToolName("mcp__srv1__search")).toBe(true);
    expect(isExternalToolName("svc__s1__call")).toBe(true);
    expect(isExternalToolName("read")).toBe(false);
    expect(isExternalToolName("create_task")).toBe(false);
  });
});

describe("prettifyToolName", () => {
  it("spaces and capitalises kebab/snake/dotted names", () => {
    expect(prettifyToolName("search-designs")).toBe("Search designs");
    expect(prettifyToolName("create_issue")).toBe("Create issue");
    expect(prettifyToolName("get.user.profile")).toBe("Get user profile");
  });
  it("collapses repeated separators and trims", () => {
    expect(prettifyToolName("a__b--c")).toBe("A b c");
  });
  it("returns the original for an empty result", () => {
    expect(prettifyToolName("")).toBe("");
  });
});

describe("externalToolLabel", () => {
  // No db → falls back to the prettified tool name.
  it("strips the namespace and prettifies the mcp tool name (no db)", () => {
    expect(externalToolLabel("mcp__BZfTDDlqAOoB__search-designs")).toBe("Search designs");
  });
  it("strips the namespace and prettifies the service tool name (no db)", () => {
    expect(externalToolLabel("svc__abc123__list_invoices")).toBe("List invoices");
  });
  it("keeps tool names that themselves contain the separator", () => {
    // parseToolName splits on the FIRST separator only.
    expect(externalToolLabel("mcp__srv1__weird__tool")).toBe("Weird tool");
  });
  it("returns non-external names unchanged", () => {
    expect(externalToolLabel("create_task")).toBe("create_task");
    expect(externalToolLabel("read")).toBe("read");
  });
});

describe("filterDisabledMcpDefs", () => {
  const def = (name: string): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } } => ({
    type: "function",
    function: { name, description: "", parameters: {} },
  });

  it("returns all defs when nothing is disabled", () => {
    const defs = [def("mcp__srv1__a"), def("mcp__srv1__b")];
    expect(filterDisabledMcpDefs(defs, [])).toHaveLength(2);
  });

  it("drops defs whose raw tool name is disabled", () => {
    const defs = [def("mcp__srv1__search-designs"), def("mcp__srv1__list_files")];
    const kept = filterDisabledMcpDefs(defs, ["search-designs"]);
    expect(kept.map((d) => d.function.name)).toEqual(["mcp__srv1__list_files"]);
  });

  it("matches on the raw name regardless of server id", () => {
    const defs = [def("mcp__OTHER__search-designs")];
    expect(filterDisabledMcpDefs(defs, ["search-designs"])).toHaveLength(0);
  });

  it("keeps defs whose name doesn't parse as an mcp tool", () => {
    const defs = [def("not-namespaced"), def("svc__s1__call")];
    expect(filterDisabledMcpDefs(defs, ["call"])).toHaveLength(2);
  });
});

describe("checkRequirements", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    applySchema(db);
    createWorkspace(db, { id: "ws-1", name: "W" });
    createProject(db, { id: "proj-1", workspaceId: "ws-1", name: "P" });
    saveMcpServer(db, {
      id: "m-linear", workspaceId: "ws-1", name: "Linear", transport: "http",
      baseUrl: "https://mcp.linear.app/mcp", enabled: true, source: "community",
      communityId: "linear", authMode: "oauth",
    });
    saveCustomService(db, {
      id: "svc-brave", workspaceId: "ws-1", name: "Brave Search",
      apiUrl: "https://api.search.brave.com", method: "GET",
      toolDefinition: JSON.stringify({ name: "brave_web_search", description: "Search", parameters: { type: "object", properties: {} } }),
      enabled: true, source: "community", communityId: "brave",
    });
  });

  afterEach(() => { db.close(); });

  it("flags a connector as attached when it is enabled + project-attached", () => {
    setToolAttachment(db, { projectId: "proj-1", toolType: "mcp", toolId: "m-linear", enabled: true });
    const status = checkRequirements(db, "ws-1", "proj-1", [{ kind: "mcp", name: "Linear" }]);
    expect(status[0]).toMatchObject({ kind: "mcp", name: "Linear", installed: true, attached: true });
  });

  it("matches by catalog id (communityId) case-insensitively", () => {
    setToolAttachment(db, { projectId: "proj-1", toolType: "mcp", toolId: "m-linear", enabled: true });
    expect(checkRequirements(db, "ws-1", "proj-1", [{ kind: "mcp", name: "LINEAR" }])[0].attached).toBe(true);
  });

  it("installed but not attached → attached false", () => {
    const status = checkRequirements(db, "ws-1", "proj-1", [{ kind: "mcp", name: "Linear" }]);
    expect(status[0]).toMatchObject({ installed: true, attached: false });
  });

  it("global-scope attachment counts as attached", () => {
    setToolAttachment(db, { projectId: "__global__", toolType: "mcp", toolId: "m-linear", enabled: true });
    expect(checkRequirements(db, "ws-1", "proj-1", [{ kind: "mcp", name: "Linear" }])[0].attached).toBe(true);
  });

  it("a disabled connector is installed but not attached", () => {
    saveMcpServer(db, {
      id: "m-github", workspaceId: "ws-1", name: "GitHub", transport: "http",
      baseUrl: "https://mcp.github.com/mcp", enabled: false, source: "community",
      communityId: "github", authMode: "oauth",
    });
    const status = checkRequirements(db, "ws-1", "proj-1", [{ kind: "mcp", name: "github" }]);
    expect(status[0]).toMatchObject({ installed: true, attached: false });
  });

  it("reports a service requirement against the service catalog", () => {
    setToolAttachment(db, { projectId: "proj-1", toolType: "service", toolId: "svc-brave", enabled: true });
    const status = checkRequirements(db, "ws-1", "proj-1", [{ kind: "service", name: "brave" }]);
    expect(status[0]).toMatchObject({ kind: "service", name: "brave", installed: true, attached: true });
  });

  it("flags a connector that is not installed at all", () => {
    const status = checkRequirements(db, "ws-1", "proj-1", [{ kind: "mcp", name: "Slack" }]);
    expect(status[0]).toMatchObject({ installed: false, attached: false });
  });

  it("handles an empty requires list", () => {
    expect(checkRequirements(db, "ws-1", "proj-1", [])).toEqual([]);
  });
});
