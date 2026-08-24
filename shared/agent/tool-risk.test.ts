/**
 * shared/agent/tool-risk — coverage + set-completeness tests.
 *
 * The review found EIGHT names in tool-risk.ts that match no registered
 * tool (`create_note` was dead — real is `ensure_note`) and SEVEN
 * registered tools that fell through the taxonomy (mis-classified as
 * WRITE and prompting the user for approval on a harmless read like
 * `get_cairn_context`). Both bugs are set-membership drift between
 * `shared/agent/tool-risk.ts` and `electron/lib/tool-schemas.ts`. This
 * test locks the invariant: every tool the runtime registers is
 * classified exactly once, and no name in the classifier is a phantom.
 */

import { describe, it, expect } from "vitest";
import { TOOL_SCHEMAS } from "../../electron/lib/tool-schemas";
import { APPROVAL_SAFE_TOOLS, riskForTool, approvalGrantScope, needsApproval } from "./tool-risk";

// Sets local to this test file — the same shape tool-risk.ts uses
// internally, re-declared here so the coverage assertion doesn't have to
// import a private symbol.
const CAIRN_WRITE_TOOLS = new Set<string>([
  "ensure_note", "patch_note", "append_to_note", "rename_note",
  "delete_note", "bulk_move_notes", "instantiate_template",
  "create_task", "update_task", "delete_task", "bulk_update_task_status",
  "spawn_tasks_from_note", "link_note_to_task", "unlink_note_from_task",
  "tag_note", "tag_task", "create_tag", "upsert_project", "delete_project",
  "create_dashboard", "update_dashboard",
  "create_idea_flow_node", "update_idea_flow_node",
  "create_idea_flow_edge", "delete_idea_flow_edge", "delete_idea_flow_node",
  "layout_idea_flow", "codebase_reindex",
  "generate_prd", "suggest_connections",
]);
const EXEC_TOOLS = new Set<string>(["bash", "spawn_subagent"]);
// dsh coding-stack tools are registered by mountCodingStack, not
// TOOL_SCHEMAS — the coverage check below asserts only Cairn-owned tools
// (the TOOL_SCHEMAS keys), while riskForTool ALSO handles dsh names.
const DSH_TOOL_NAMES = new Set<string>([
  "read", "read_image", "glob", "grep", "plan", "exit_plan_mode",
  "write", "edit", "str_replace_editor", "todo_write", "skill", "bash",
]);

describe("tool-risk classifier — set membership", () => {
  it("every Cairn-registered tool is classified into exactly ONE bucket", () => {
    const missing: string[] = [];
    const doubles: string[] = [];
    for (const name of Object.keys(TOOL_SCHEMAS)) {
      const inSafe = APPROVAL_SAFE_TOOLS.has(name);
      const inWrite = CAIRN_WRITE_TOOLS.has(name);
      const inExec = EXEC_TOOLS.has(name);
      const count = Number(inSafe) + Number(inWrite) + Number(inExec);
      if (count === 0) missing.push(name);
      if (count > 1) doubles.push(name);
    }
    expect(missing, `Cairn tools not classified in tool-risk.ts: ${missing.join(", ")}`).toEqual([]);
    expect(doubles, `Cairn tools double-classified in tool-risk.ts: ${doubles.join(", ")}`).toEqual([]);
  });

  it("no phantom names — every entry in APPROVAL_SAFE_TOOLS is either a Cairn tool or a known dsh tool", () => {
    const phantom: string[] = [];
    for (const name of APPROVAL_SAFE_TOOLS) {
      if (name in TOOL_SCHEMAS) continue;
      if (DSH_TOOL_NAMES.has(name)) continue;
      phantom.push(name);
    }
    expect(phantom, `APPROVAL_SAFE_TOOLS references phantom names: ${phantom.join(", ")}`).toEqual([]);
  });

  it("no phantom names in CAIRN_WRITE_TOOLS", () => {
    const phantom: string[] = [];
    for (const name of CAIRN_WRITE_TOOLS) {
      if (!(name in TOOL_SCHEMAS)) phantom.push(name);
    }
    expect(phantom, `CAIRN_WRITE_TOOLS references phantom names: ${phantom.join(", ")}`).toEqual([]);
  });

  it("read-only Cairn tools do NOT prompt for approval", () => {
    // Sanity list — the exact names that used to fall through.
    for (const name of [
      "get_cairn_context", "get_project_context_pack", "list_folders",
      "get_dashboard_constants", "get_knowledge_graph", "get_semantic_neighbors",
    ]) {
      expect(needsApproval(name), `${name} should be gate-free (read-only)`).toBe(false);
      expect(riskForTool(name)).toBe("READ");
    }
  });

  it("layout_idea_flow and codebase_reindex are WRITE (they mutate local data)", () => {
    for (const name of ["layout_idea_flow", "codebase_reindex"]) {
      expect(riskForTool(name)).toBe("WRITE_LOCAL");
      expect(needsApproval(name)).toBe(true);
      expect(approvalGrantScope(name)).toBe("session");
    }
  });

  it("bash is EXEC with a command grant scope; spawn_subagent is EXEC with none", () => {
    expect(riskForTool("bash")).toBe("EXEC");
    expect(approvalGrantScope("bash")).toBe("command");
    expect(riskForTool("spawn_subagent")).toBe("EXEC");
    expect(approvalGrantScope("spawn_subagent")).toBe("none");
  });

  it("mcp__ / svc__ prefixes classify as EXTERNAL and never gain a standing grant path", () => {
    expect(riskForTool("mcp__github__create_issue")).toBe("EXTERNAL");
    expect(riskForTool("svc__internal__ping")).toBe("EXTERNAL");
    expect(approvalGrantScope("mcp__x__y")).toBe("session");
    expect(approvalGrantScope("svc__x__y")).toBe("session");
  });

  it("unknown tools fail closed — needsApproval=true, WRITE_LOCAL risk", () => {
    expect(needsApproval("some_new_tool_not_yet_classified")).toBe(true);
    expect(riskForTool("some_new_tool_not_yet_classified")).toBe("WRITE_LOCAL");
  });
});
