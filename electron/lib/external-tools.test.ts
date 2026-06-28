import { describe, it, expect, vi } from "vitest";

// external-tools imports mcp-client + custom-services (→ secure-store → electron).
vi.mock("electron", () => ({
  app: { isReady: () => false, getPath: () => "/tmp" },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { resolveAttachedToolIds, isExternalToolName, prettifyToolName, externalToolLabel, filterDisabledMcpDefs } from "./external-tools";

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
