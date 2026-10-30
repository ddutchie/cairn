import { describe, it, expect } from "vitest";
import { buildInventory, CHAT_GATED_TOOLS } from "./tool-inventory";
import { TOOL_SCHEMAS, CHAT_ONLY_TOOLS, CHAT_EXCLUDED_TOOLS } from "./tool-schemas";

describe("tool-inventory", () => {
  it("chat registers the Cairn data tools except the codebase index, with deletes gated", async () => {
    const inv = await buildInventory();
    const cairn = inv.chat.filter((t) => t.source === "cairn");
    expect(cairn.length).toBe(Object.keys(TOOL_SCHEMAS).length - CHAT_EXCLUDED_TOOLS.length);
    for (const name of CHAT_EXCLUDED_TOOLS) {
      expect(cairn.some((t) => t.name === name)).toBe(false);
      expect(inv.coding.some((t) => t.name === name)).toBe(true);
    }
    for (const name of CHAT_GATED_TOOLS) expect(cairn.find((t) => t.name === name)?.gated).toBe(true);
  });

  it("coding adds the filesystem and exec tools chat never mounts", async () => {
    const inv = await buildInventory();
    const names = new Set(inv.coding.map((t) => t.name));
    for (const n of ["read", "edit", "write", "grep", "glob", "bash", "todo_write", "subagent", "lsp"]) expect(names.has(n)).toBe(true);
    const chatNames = new Set(inv.chat.map((t) => t.name));
    for (const n of ["read", "edit", "bash"]) expect(chatNames.has(n)).toBe(false);
  });

  it("automation-dev has file tools only: no Cairn data tools, no shell", async () => {
    const inv = await buildInventory();
    expect(inv["automation-dev"].some((t) => t.source === "cairn")).toBe(false);
    const names = new Set(inv["automation-dev"].map((t) => t.name));
    for (const n of ["read", "write", "edit", "grep", "glob"]) expect(names.has(n)).toBe(true);
    for (const n of ["bash", "terminal_open"]) expect(names.has(n)).toBe(false);
  });

  it("mcp excludes chat-only tools", async () => {
    const inv = await buildInventory();
    const names = new Set(inv.mcp.map((t) => t.name));
    for (const n of CHAT_ONLY_TOOLS) expect(names.has(n as string)).toBe(false);
    expect(inv.mcp.length).toBe(Object.keys(TOOL_SCHEMAS).length - CHAT_ONLY_TOOLS.length);
  });
});
