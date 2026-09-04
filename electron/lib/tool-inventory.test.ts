import { describe, it, expect } from "vitest";
import {
  buildStaticInventory,
  CODING_FS_TOOLS,
  CODING_EXEC_TOOLS,
  CHAT_GATED_TOOLS,
  CHAT_DENIED_GLOBAL_TOOLS,
  type InventoryTool,
} from "./tool-inventory";
import { TOOL_SCHEMAS, CHAT_ONLY_TOOLS } from "./tool-schemas";
import { CHAT_FORBIDDEN_TOOLS } from "../cordis/cairn-tools";

describe("tool-inventory", () => {
  it("mirrors CHAT_FORBIDDEN_TOOLS so the gated badge can't drift", () => {
    expect(new Set(CHAT_GATED_TOOLS)).toEqual(CHAT_FORBIDDEN_TOOLS);
  });

  it("chat registers all Cairn tools with deletes marked gated (matches chat-session-runner)", () => {
    const inv = buildStaticInventory([]);
    const cairn = inv.chat.filter((t) => t.source === "cairn");
    expect(cairn.length).toBe(Object.keys(TOOL_SCHEMAS).length);
    for (const name of CHAT_FORBIDDEN_TOOLS) {
      expect(cairn.find((t) => t.name === name)?.gated).toBe(true);
    }
  });

  it("coding adds read/edit/bash-family tools chat never mounts", () => {
    const inv = buildStaticInventory([]);
    const names = new Set(inv.coding.map((t) => t.name));
    for (const n of ["read", "edit", "write", "grep", "glob", "bash", "todo_write"]) {
      expect(names.has(n)).toBe(true);
    }
    const chatNames = new Set(inv.chat.map((t) => t.name));
    for (const n of ["read", "edit", "bash"]) {
      expect(chatNames.has(n)).toBe(false);
    }
  });

  it("automation-dev has file tools only: no Cairn data tools, no shell", () => {
    const inv = buildStaticInventory([]);
    expect(inv["automation-dev"].some((t) => t.source === "cairn")).toBe(false);
    const names = new Set(inv["automation-dev"].map((t) => t.name));
    for (const n of ["read", "write", "edit", "grep", "glob", "todo_write"]) {
      expect(names.has(n)).toBe(true);
    }
    for (const t of CODING_EXEC_TOOLS) {
      expect(names.has(t.name)).toBe(false);
    }
    expect(CODING_FS_TOOLS.length).toBeGreaterThan(0);
  });

  it("mcp excludes chat-only tools", () => {
    const inv = buildStaticInventory([]);
    const names = new Set(inv.mcp.map((t) => t.name));
    for (const n of CHAT_ONLY_TOOLS) {
      expect(names.has(n as string)).toBe(false);
    }
    expect(inv.mcp.length).toBe(Object.keys(TOOL_SCHEMAS).length - CHAT_ONLY_TOOLS.length);
  });

  it("chat hides denied global tools (skill) that coding keeps", () => {
    const global: InventoryTool[] = [
      { name: "skill", description: "Load skill instructions.", category: "exec", source: "global" },
      { name: "subagent", description: "Delegate to a subagent.", category: "exec", source: "global" },
    ];
    const inv = buildStaticInventory(global);
    const chatNames = new Set(inv.chat.map((t) => t.name));
    expect(chatNames.has("skill")).toBe(false);
    expect(chatNames.has("subagent")).toBe(true);
    const codingNames = new Set(inv.coding.map((t) => t.name));
    expect(codingNames.has("skill")).toBe(true);
    expect(CHAT_DENIED_GLOBAL_TOOLS).toContain("skill");
  });
});
