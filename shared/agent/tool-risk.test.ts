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
import { APPROVAL_SAFE_TOOLS, riskForTool, approvalGrantScope, needsApproval, needsApprovalForCall, type RiskClass, type GrantScope } from "./tool-risk";

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
  "update_user_writing_style",
]);
const EXEC_TOOLS = new Set<string>(["bash", "subagent"]);
// dsh coding-stack tools are registered by mountCodingStack, not
// TOOL_SCHEMAS — the coverage check below asserts only Cairn-owned tools
// (the TOOL_SCHEMAS keys), while riskForTool ALSO handles dsh names.
const DSH_TOOL_NAMES = new Set<string>([
  "read", "read_image", "glob", "grep", "plan", "exit_plan_mode",
  "write", "edit", "str_replace_editor", "todo_write", "skill", "bash",
  "subagent", "delegate", "send_message", "interrupt_agent", "list_agents",
  "job_list", "job_output", "job_kill",
]);

// Expected risk bucket + approval behaviour for each dsh coding-stack tool the
// runtime actually registers (names taken from cordis-context.ts / dsh
// tool-*). This locks the taxonomy to the real names so a rename (like the
// old `spawn_subagent` phantom) can't silently mis-gate a tool again.
const DSH_TOOL_EXPECTATIONS: Array<[string, RiskClass, boolean, GrantScope]> = [
  ["read", "READ", false, "none"],
  ["read_image", "READ", false, "none"],
  ["glob", "READ", false, "none"],
  ["grep", "READ", false, "none"],
  ["exit_plan_mode", "READ", false, "none"],
  ["skill", "READ", false, "none"],
  ["write", "WRITE_LOCAL", true, "session"],
  ["edit", "WRITE_LOCAL", true, "session"],
  ["str_replace_editor", "WRITE_LOCAL", true, "session"],
  ["todo_write", "WRITE_LOCAL", true, "session"],
  ["bash", "EXEC", true, "command"],
  ["subagent", "EXEC", true, "none"],
  ["delegate", "EXEC", true, "none"],
  ["send_message", "EXEC", true, "none"],
  ["interrupt_agent", "EXEC", true, "none"],
  ["list_agents", "READ", false, "none"],
  ["job_list", "READ", false, "none"],
  ["job_output", "READ", false, "none"],
  ["job_kill", "EXEC", true, "none"],
];

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

  it("bash is EXEC with a command grant scope; subagent is EXEC with none", () => {
    expect(riskForTool("bash")).toBe("EXEC");
    expect(approvalGrantScope("bash")).toBe("command");
    expect(riskForTool("subagent")).toBe("EXEC");
    expect(approvalGrantScope("subagent")).toBe("none");
    // `spawn_subagent` was the old phantom name — it must NOT be treated as the
    // real tool. It falls through to the conservative WRITE_LOCAL default.
    expect(riskForTool("spawn_subagent")).toBe("WRITE_LOCAL");
  });

  it("continuable-control tools: delegate/send_message/interrupt_agent are one-off EXEC, list_agents is READ", () => {
    for (const name of ["delegate", "send_message", "interrupt_agent"]) {
      expect(riskForTool(name)).toBe("EXEC");
      expect(needsApproval(name)).toBe(true);
      // One-off decisions — a standing session grant would be overbroad.
      expect(approvalGrantScope(name)).toBe("none");
    }
    expect(riskForTool("list_agents")).toBe("READ");
    expect(needsApproval("list_agents")).toBe(false);
    expect(approvalGrantScope("list_agents")).toBe("none");
  });

  it("every registered dsh coding-stack tool maps to its expected risk bucket", () => {
    for (const [name, risk, gated, scope] of DSH_TOOL_EXPECTATIONS) {
      expect(riskForTool(name), `${name} risk`).toBe(risk);
      expect(needsApproval(name), `${name} gated`).toBe(gated);
      expect(approvalGrantScope(name), `${name} grant scope`).toBe(scope);
    }
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

  it("str_replace_editor view is read-only (no prompt); its writes still gate", () => {
    // view only reads a file — args-aware gate lets it through.
    expect(needsApprovalForCall("str_replace_editor", { command: "view", path: "/x" })).toBe(false);
    // create/str_replace/insert still require approval.
    expect(needsApprovalForCall("str_replace_editor", { command: "create", path: "/x" })).toBe(true);
    expect(needsApprovalForCall("str_replace_editor", { command: "str_replace", path: "/x" })).toBe(true);
    // No args → falls back to the name-only gate (still gated).
    expect(needsApprovalForCall("str_replace_editor")).toBe(true);
    // Other tools are unaffected by the args-aware path.
    expect(needsApprovalForCall("bash", { command: "view" })).toBe(true);
    expect(needsApprovalForCall("read", {})).toBe(false);
  });
});
