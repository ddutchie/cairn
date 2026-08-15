/**
 * pi-agent toolset — persona-driven tool restrictions.
 *
 * The "automation-dev" persona (used by the automation Develop modal) must be
 * restricted to FILE tools only: read/write/edit/grep/find/ls. No shell
 * (bash), no Cairn data tools (create_task / ensure_note / …), no todowrite,
 * no subagents, no external connectors — a Develop session can only author
 * files inside the automation folder, so it can never touch the user's board
 * or notes or run arbitrary commands.
 */

import { describe, it, expect } from "vitest";
import { getAllToolDefs } from "./pi-agent-loop";

function toolNames(role: "default" | "automation-dev"): string[] {
  return getAllToolDefs("execute", [], [], false, role).map((t) => t.function.name);
}

const FILE_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const DEV_FILE_TOOLS = FILE_TOOLS.filter((t) => t !== "bash");

describe("getAllToolDefs persona", () => {
  it("default persona offers file tools AND Cairn data tools", () => {
    const names = new Set(toolNames("default"));
    for (const t of FILE_TOOLS) expect(names.has(t)).toBe(true);
    expect(names.has("create_task")).toBe(true);
    expect(names.has("ensure_note")).toBe(true);
    expect(names.has("todowrite")).toBe(true);
  });

  it("automation-dev persona offers file tools only (and no shell)", () => {
    const names = new Set(toolNames("automation-dev"));
    for (const t of DEV_FILE_TOOLS) expect(names.has(t)).toBe(true);
    expect(names.has("bash")).toBe(false);
  });

  it("automation-dev persona excludes every Cairn data / side-effecting tool", () => {
    const names = new Set(toolNames("automation-dev"));
    const FORBIDDEN = [
      "create_task", "update_task", "ensure_note", "patch_note", "create_tag",
      "get_idea_flow", "create_idea_flow_node", "todowrite", "skill",
      "spawn_subagent", "get_active_context", "ask_questions",
    ];
    for (const tool of FORBIDDEN) {
      expect(names.has(tool)).toBe(false);
    }
  });

  it("automation-dev persona never offers external connectors", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const external = [{ type: "function", function: { name: "mcp__srv__search", description: "x", parameters: {} } } as any];
    const names = new Set(getAllToolDefs("execute", [], external, false, "automation-dev").map((t) => t.function.name));
    expect(names.has("mcp__srv__search")).toBe(false);
  });
});
