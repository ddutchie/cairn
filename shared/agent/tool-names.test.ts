/**
 * shared/agent/tool-names — equivalence + pinned-answer tests (plan §C2).
 *
 * For every name in TOOL_SCHEMAS plus the engine toolset, the new shared
 * predicate must equal the inline copy it replaces. The legacy expressions
 * are written out verbatim below so a drift in either direction fails
 * loudly. The pinned tables lock today's answers for the names the plan
 * calls out (safe-set growth: terminal_list/read, lsp, session_*,
 * job_list/output; EXEC: subagent/delegate/send_message/interrupt_agent/
 * job_kill/terminal_*).
 *
 * Import discipline: this test must import nothing beyond TOOL_SCHEMAS
 * (zod + shared only, the same precedent tool-risk.test.ts follows).
 * Importing tool-inventory or automation-script would drag Node and engine
 * modules into the `tsconfig.shared.json` program and break
 * `type-check:shared` (isolatedModules re-export errors in the pulled-in
 * electron files). The engine-name list below is static and was verified
 * against `buildInventory()` output; `run_script` is a literal for the same
 * reason (it must equal RUN_SCRIPT_TOOL_NAME in
 * electron/lib/automation-script.ts).
 */

import { describe, it, expect } from "vitest";
import { TOOL_SCHEMAS } from "../../electron/lib/tool-schemas";
import { APPROVAL_SAFE_TOOLS } from "./tool-risk";
import { isCairnReadTool, isExternalToolName, SHELL_TOOLS, CODE_EXEC_TOOLS } from "./tool-names";

/** Literal value of RUN_SCRIPT_TOOL_NAME (see note above). */
const RUN_SCRIPT = "run_script";

// ── Legacy copies, verbatim ────────────────────────────────────────────────
// automation-approval isReadTool (READ_TOOL_PREFIXES + codebase_query)
const legacyIsReadTool = (name: string): boolean => {
  if (name === "codebase_query") return true;
  return ["get_", "list_", "search_"].some((p) => name.startsWith(p));
};
// automation-approval isExternalTool (/^(?:mcp|svc)__/)
const legacyIsExternalTool = (name: string): boolean => /^(?:mcp|svc)__/.test(name);
// tool-schemas toolCategory's read arm
const legacyToolCategoryRead = (name: string): boolean =>
  name === "codebase_query" ||
  name.startsWith("get_") ||
  name.startsWith("list_") ||
  name.startsWith("search_");
// tool-inventory READ_TOOLS membership (engine read names)
const legacyInventoryReadTools = new Set([
  "read", "read_image", "glob", "grep", "lsp", "terminal_read", "terminal_list",
  "list_agents", "job_output", "get_goal", "schedule_list", "web_fetch", "skill",
]);
// tool-risk SHELL_TOOLS (post-Q6: bash only — pwsh retired from gating).
const legacyIsShellTool = (name: string): boolean => name === "bash";
// automation-approval / approval-grant-queries CODE_EXEC_TOOLS
// (post-Q6: run_script + bash — pwsh retired from gating).
const legacyIsCodeExecTool = (name: string): boolean =>
  name === RUN_SCRIPT || name === "bash";

// Engine names exercising the EXEC paths of riskForTool, plus the retired
// Q6 names (universe fodder for the equivalence checks — not expectations).
const EXEC_ENGINE_TOOLS = [
  "bash", "pwsh", "subagent", "delegate", "send_message", "interrupt_agent",
  "job_kill", "terminal_open", "terminal_send", "terminal_signal", "terminal_close",
];

// Every other name buildInventory() registers that is neither a TOOL_SCHEMAS
// key nor in APPROVAL_SAFE_TOOLS (verified against its output).
const ENGINE_EXTRA_TOOLS = [
  "write", "edit", "todo_write",
  "web_search", "web_fetch",
  "plan",
  "get_goal", "create_goal", "update_goal",
  "schedule_create", "schedule_list", "schedule_cancel",
  "job_output",
  "search_sessions", "read_session",
  "workflow", "ralph",
];

// Synthetic edge cases: namespaced variants, legacy per-operation names,
// retired Q6 names (must behave identically old vs new), unknowns.
const SYNTHETIC_NAMES = [
  "mcp__github__create_issue", "mcp__x__y", "svc__internal__ping", "svc__x__y",
  "mcp__", "svc__", "mcp_", "svc_", "xmcp__foo",
  "delete_note", "get_cairn_context", "list_", "get_", "search_", "",
  "pwsh", "str_replace_editor",
  "some_new_tool_not_yet_classified",
];

function toolNameUniverse(): Set<string> {
  return new Set([
    ...Object.keys(TOOL_SCHEMAS),
    ...APPROVAL_SAFE_TOOLS,
    ...EXEC_ENGINE_TOOLS,
    ...ENGINE_EXTRA_TOOLS,
    ...SYNTHETIC_NAMES,
  ]);
}

describe("tool-names — equivalence with the replaced copies", () => {
  it("isCairnReadTool equals automation-approval isReadTool for every known tool", () => {
    for (const name of toolNameUniverse()) {
      expect(isCairnReadTool(name), name).toBe(legacyIsReadTool(name));
    }
  });

  it("isCairnReadTool equals toolCategory's read arm for every known tool", () => {
    for (const name of toolNameUniverse()) {
      expect(isCairnReadTool(name), name).toBe(legacyToolCategoryRead(name));
    }
  });

  it("isExternalToolName equals the /^(?:mcp|svc)__/ regex for every known tool", () => {
    for (const name of toolNameUniverse()) {
      expect(isExternalToolName(name), name).toBe(legacyIsExternalTool(name));
    }
  });

  it("SHELL_TOOLS equals the tool-risk shell set for every known tool", () => {
    for (const name of toolNameUniverse()) {
      expect(SHELL_TOOLS.has(name), name).toBe(legacyIsShellTool(name));
    }
  });

  it("CODE_EXEC_TOOLS equals both replaced sets for every known tool", () => {
    for (const name of toolNameUniverse()) {
      expect(CODE_EXEC_TOOLS.has(name), name).toBe(legacyIsCodeExecTool(name));
    }
  });

  it("READ_TOOLS members without a read prefix are exactly the engine-membership reads", () => {
    // list_agents and get_goal are covered by the shared predicate; the rest
    // are READ by set membership in tool-inventory.ts only (they carry no
    // get_/list_/search_ prefix). If this list changes, the inventory's
    // engine half and the shared predicate have drifted apart — check
    // categoryOf in electron/lib/tool-inventory.ts.
    const withoutPrefix = [...legacyInventoryReadTools].filter((n) => !isCairnReadTool(n)).sort();
    expect(withoutPrefix).toEqual(
      ["glob", "grep", "job_output", "lsp", "read", "read_image", "schedule_list", "skill", "terminal_list", "terminal_read", "web_fetch"],
    );
  });
});

describe("tool-names — pinned answers", () => {
  it.each([
    // [name, expected]
    ["get_context", true],
    ["get_item", true],
    ["search_notes", true],
    ["search_tasks", true],
    ["get_idea_flow", true],
    ["get_graph", true],
    ["get_user_writing_style", true],
    ["codebase_query", true],
    // Engine read names with a read prefix.
    ["list_agents", true],
    ["get_goal", true],
    ["search_sessions", true],
    ["list_mcp_resources", true],
    ["list_mcp_resource_templates", true],
    // Writes, deletes, exec, unknowns.
    ["ensure_note", false],
    ["edit_note", false],
    ["create_task", false],
    ["delete", false],
    ["delete_note", false],
    ["write", false],
    ["edit", false],
    ["todo_write", false],
    ["bash", false],
    ["pwsh", false],
    ["subagent", false],
    ["skill", false],
    ["web_fetch", false],
    ["web_search", false],
    // Engine reads WITHOUT a read prefix stay false here (they are
    // READ by set membership in tool-risk.ts / tool-inventory.ts, not by name).
    ["read", false],
    ["read_image", false],
    ["glob", false],
    ["grep", false],
    ["lsp", false],
    ["terminal_read", false],
    ["terminal_list", false],
    ["job_list", false],
    ["job_output", false],
    ["session_search", false],
    ["session_event_search", false],
    ["session_trace", false],
    ["session_event_trace", false],
    ["session_event_read", false],
    ["read_session", false],
    ["read_mcp_resource", false],
    ["schedule_list", false],
    ["plan", false],
    ["exit_plan_mode", false],
    // External names are not Cairn reads.
    ["mcp__github__create_issue", false],
    ["svc__internal__ping", false],
    ["some_new_tool_not_yet_classified", false],
  ] satisfies Array<[string, boolean]>)("isCairnReadTool(%s) === %s", (name, expected) => {
    expect(isCairnReadTool(name)).toBe(expected);
  });

  it.each([
    ["mcp__github__create_issue", true],
    ["mcp__x__y", true],
    ["svc__internal__ping", true],
    ["svc__x__y", true],
    ["get_context", false],
    ["list_mcp_resources", false],
    ["read_mcp_resource", false],
    ["bash", false],
    ["search_notes", false],
    ["mcp_", false],
    ["svc_", false],
    ["xmcp__foo", false],
    ["pwsh", false],
    ["str_replace_editor", false],
  ] satisfies Array<[string, boolean]>)("isExternalToolName(%s) === %s", (name, expected) => {
    expect(isExternalToolName(name)).toBe(expected);
  });

  it("SHELL_TOOLS is exactly {bash} (pwsh retired from gating in Q6)", () => {
    expect(new Set(SHELL_TOOLS)).toEqual(new Set(["bash"]));
  });

  it("CODE_EXEC_TOOLS is exactly {bash, run_script} (pwsh retired in Q6)", () => {
    expect(new Set(CODE_EXEC_TOOLS)).toEqual(new Set(["bash", RUN_SCRIPT]));
  });
});
