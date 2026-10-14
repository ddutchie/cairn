/**
 * Cairn — Automation approval gate
 *
 * The human-in-the-loop policy for background automation runs. In 'ask' mode,
 * write tools park a durable approval item in the inbox and block until the
 * user resolves it (approve/deny). In 'auto' mode (default) nothing is gated.
 * Read-only tools are never gated — they cannot change state.
 *
 * This module is deliberately light (no dependencies on the agent loop or
 * approval inbox — those were retired) so the policy is unit-testable in
 * isolation. Consumed by heartbeat-runner (auto-allow / auto-deny decision)
 * and the automation-manifest sync path (sanitizeStandingRules on ingest).
 */

import type Database from "better-sqlite3";
import { getAutomationById, getAutomationRunById, updateAutomation } from "../db/automation-queries";
import { RUN_SCRIPT_TOOL_NAME } from "./automation-script";


/** How long a parked approval waits for a user decision before failing closed. */
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** Read-only tool names are never gated — they can't change state. */
const READ_TOOL_PREFIXES = ["get_", "list_", "search_"];
/**
 * True for external-tool names (namespaced MCP `mcp__…` / service `svc__…`
 * calls). Mirrors isExternalToolName in external-tools.ts — kept local so the
 * policy module stays dependency-light (no pull of the MCP client stack).
 */
export function isExternalTool(name: string): boolean {
  return /^(?:mcp|svc)__/.test(name);
}

export function isReadTool(name: string): boolean {
  // codebase_query is read-only (READ in shared/agent/tool-risk.ts) but
  // matches no prefix — name it explicitly so automations don't gate it.
  if (name === "codebase_query") return true;
  return READ_TOOL_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * The standing-rule target for a tool call — the specific thing "always allow"
 * grants. run_script grants the SCRIPT NAME (never blanket shell); bash grants
 * the exact command; other tools grant their primary identifier (path /
 * note / card / title). Shared by the gate (match) and the resolve handler
 * (persist) so the two can never disagree about what was granted.
 */
export function standingRuleTarget(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === RUN_SCRIPT_TOOL_NAME) {
    return typeof args.name === "string" && args.name ? args.name : undefined;
  }
  if (tool === "bash" || tool === "pwsh") {
    return typeof args.command === "string" && args.command ? args.command : undefined;
  }
  // Single-item lists (update_tasks cardIds, update_notes noteIds) and the
  // generic delete's `id` target one entity just like noteId/cardId did.
  const single = (v: unknown) => (Array.isArray(v) && v.length === 1 ? v[0] : undefined);
  const target = [args.path, args.noteId, args.cardId, single(args.noteIds), single(args.cardIds), args.id, args.title]
    .find((v): v is string => typeof v === "string" && v.length > 0);
  return target;
}

/**
 * Tool names whose standing rules also cover a consolidated tool. Rules saved
 * before the toolset was consolidated (v3.1.3) name the per-operation tools;
 * they keep applying to the tool that replaced them.
 */
const LEGACY_RULE_TOOLS: Record<string, readonly string[]> = {
  edit_note:    ["patch_note", "append_to_note"],
  update_notes: ["rename_note", "bulk_move_notes", "tag_note", "link_note_to_task", "unlink_note_from_task"],
  update_tasks: ["update_task", "bulk_update_task_status", "tag_task", "link_note_to_task", "unlink_note_from_task"],
  task_progress: ["claim_task", "add_task_progress"],
  ensure_note:  ["instantiate_template"],
  edit_idea_flow: ["create_idea_flow_node", "update_idea_flow_node", "create_idea_flow_edge", "delete_idea_flow_node", "delete_idea_flow_edge", "layout_idea_flow"],
  delete:       ["delete_note", "delete_task", "delete_project", "delete_idea_flow_node", "delete_idea_flow_edge"],
};

/**
 * Does a standing rule recorded for `ruleTool` cover a call to `tool`?
 *
 * Legacy (pre-consolidation) rules name the per-operation tool; they keep
 * applying to the consolidated tool that replaced them — but ONLY for the
 * matching sub-action. Without the args check a rule saved for `delete_note`
 * would also approve `delete {type:"project"}` (wiping a whole project), a
 * `tag_note` rule would approve any `update_notes` rename/move, and a
 * `claim_task` rule would approve `task_progress {action:"log", moveTo:"done"}`.
 * Exact (non-legacy) tool-name matches are unaffected.
 */
export function standingRuleCoversTool(ruleTool: string, tool: string, args: Record<string, unknown> = {}): boolean {
  if (ruleTool === tool) return true;
  if (!(LEGACY_RULE_TOOLS[tool]?.includes(ruleTool) ?? false)) return false;
  return legacyRuleMatchesSubAction(ruleTool, tool, args);
}

/** Non-empty string list helper for sub-action matching below. */
function hasIds(v: unknown): boolean {
  return Array.isArray(v) && v.some((e) => typeof e === "string" && (e as string).length > 0);
}

/**
 * True when the consolidated call's arguments actually exercise the operation
 * the legacy rule was recorded for. Unknown/absent sub-action markers fail
 * closed (no coverage) — a standing rule must never approve an action the
 * user never explicitly allowed.
 */
function legacyRuleMatchesSubAction(ruleTool: string, tool: string, args: Record<string, unknown>): boolean {
  switch (tool) {
    case "delete": {
      switch (ruleTool) {
        case "delete_note":  return args.type === "note";
        case "delete_task":  return args.type === "task";
        case "delete_project": return args.type === "project";
        case "delete_idea_flow_node": return args.type === "flow_node";
        case "delete_idea_flow_edge": return args.type === "flow_edge";
        default: return false;
      }
    }
    case "update_notes": {
      switch (ruleTool) {
        case "rename_note":          return args.title !== undefined;
        case "bulk_move_notes":      return args.folder !== undefined;
        case "tag_note":             return hasIds(args.tagNames);
        case "link_note_to_task":    return hasIds(args.linkCardIds);
        case "unlink_note_from_task": return hasIds(args.unlinkCardIds);
        default: return false;
      }
    }
    case "update_tasks": {
      switch (ruleTool) {
        case "update_task":
          return args.title !== undefined || args.description !== undefined ||
            args.priority !== undefined || args.dueDate !== undefined ||
            args.assignee !== undefined || args.archived !== undefined ||
            args.columnType !== undefined || args.columnId !== undefined ||
            hasIds(args.blockedBy) || hasIds(args.unblockFrom);
        case "bulk_update_task_status":
          return args.columnType !== undefined || args.columnId !== undefined;
        case "tag_task":
          return hasIds(args.tagNames);
        case "link_note_to_task":
          return hasIds(args.linkNoteIds);
        case "unlink_note_from_task":
          return hasIds(args.unlinkNoteIds);
        default: return false;
      }
    }
    case "task_progress": {
      if (ruleTool === "claim_task") return args.action === "claim";
      if (ruleTool === "add_task_progress") return args.action === "log";
      return false;
    }
    case "edit_idea_flow": {
      const ops = Array.isArray(args.ops) ? (args.ops as Array<{ op?: unknown }>) : [];
      const kinds = new Set(ops.map((o) => o?.op));
      switch (ruleTool) {
        case "create_idea_flow_node": return kinds.has("add_node");
        case "update_idea_flow_node": return kinds.has("update_node");
        case "create_idea_flow_edge": return kinds.has("add_edge");
        case "delete_idea_flow_node": return kinds.has("delete_node");
        case "delete_idea_flow_edge": return kinds.has("delete_edge");
        case "layout_idea_flow":      return args.layout !== undefined;
        default: return false;
      }
    }
    // edit_note (patch/append) and ensure_note (instantiate_template) have no
    // narrower sub-action to distinguish — the legacy rule covers the call.
    default:
      return true;
  }
}

/**
 * Code-executing tools. A standing rule for these WITHOUT a concrete target
 * (script name / exact command) would be a wildcard grant — it would match
 * every `run_script`/`bash` call, i.e. permanent auto-approval of arbitrary
 * execution. The approval inbox's "Always allow" always records a concrete
 * target (see standingRuleTarget), so a target-less rule can only enter via a
 * hand/agent-authored manifest — sanitise those on ingest.
 */
const CODE_EXEC_TOOLS = new Set([RUN_SCRIPT_TOOL_NAME, "bash", "pwsh"]);

/**
 * Persist an "always allow" decision as a standing rule on the run's automation
 * (deduped by tool + target), so future runs let it through without asking.
 * Used by the approval inbox resolve path; exported for tests.
 *
 * Refuses to record a TARGET-LESS rule for a code-executing tool: without a
 * script/command target that would be a wildcard grant of arbitrary execution,
 * so an "Always allow" click on a call that carried no derivable target is a
 * no-op instead of a permanent blanket approval.
 */
export function recordStandingAllowance(
  db: Database.Database,
  runId: string,
  tool: string,
  args: Record<string, unknown>,
): void {
  const run = getAutomationRunById(db, runId);
  const automation = run ? getAutomationById(db, run.automationId) : null;
  if (!automation) return;
  const target = standingRuleTarget(tool, args);
  if (CODE_EXEC_TOOLS.has(tool) && !target) return;
  const rules = automation.standingRules.filter((r) => !(r.tool === tool && r.target === target));
  updateAutomation(db, automation.id, {
    standingRules: [...rules, { tool, ...(target ? { target } : {}) }],
  });
}

/**
 * Sanitise a set of standing rules before persisting them (used by the
 * manifest sync path). Rules are dropped — never clamped — when unsafe or
 * malformed, so a bad manifest can't silently grant or block anything it
 * shouldn't. Returns the safe rules plus human-readable reasons for anything
 * dropped (surfaced to the user).
 */
export function sanitizeStandingRules(
  rules: unknown,
): { rules: Array<{ tool: string; target?: string }>; dropped: string[] } {
  if (!Array.isArray(rules)) return { rules: [], dropped: [] };
  const out: Array<{ tool: string; target?: string }> = [];
  const dropped: string[] = [];
  for (const raw of rules) {
    if (!raw || typeof raw !== "object") {
      dropped.push("Malformed rule (not an object)");
      continue;
    }
    const rec = raw as { tool?: unknown; target?: unknown };
    if (typeof rec.tool !== "string" || !rec.tool.trim()) {
      dropped.push("Rule with missing tool name");
      continue;
    }
    const tool = rec.tool.trim();
    const target = typeof rec.target === "string" && rec.target.trim() ? rec.target.trim() : undefined;
    if (CODE_EXEC_TOOLS.has(tool)) {
      if (!target) {
        dropped.push(
          `${tool} without a target — this would blanket-approve arbitrary execution, so it was skipped`,
        );
        continue;
      }
      out.push({ tool, target });
    } else {
      out.push({ tool, ...(target ? { target } : {}) });
    }
  }
  return { rules: out, dropped };
}


