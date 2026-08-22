/**
 * Cairn — Automation approval gate
 *
 * The human-in-the-loop policy for background automation runs. In 'ask' mode,
 * write tools park a durable approval item in the inbox and block until the
 * user resolves it (approve/deny). In 'auto' mode (default) nothing is gated.
 * Read-only tools are never gated — they cannot change state.
 *
 * This module is deliberately light (only depends on approval-queries + mcp/db)
 * so the policy is unit-testable without pulling in the agent loop.
 */

import type Database from "better-sqlite3";
import { insertNotification } from "../mcp/db";
import {
  getApprovalItemById,
  resolveApproval,
  type ApprovalItem,
  type ApprovalResolution,
} from "../db/approval-queries";
import { getAutomationById, getAutomationRunById, updateAutomation, type Automation, type AutomationRun } from "../db/automation-queries";
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
  if (tool === "bash") {
    return typeof args.command === "string" && args.command ? args.command : undefined;
  }
  const target = [args.path, args.noteId, args.cardId, args.title]
    .find((v): v is string => typeof v === "string" && v.length > 0);
  return target;
}

/**
 * Code-executing tools. A standing rule for these WITHOUT a concrete target
 * (script name / exact command) would be a wildcard grant — it would match
 * every `run_script`/`bash` call, i.e. permanent auto-approval of arbitrary
 * execution. The approval inbox's "Always allow" always records a concrete
 * target (see standingRuleTarget), so a target-less rule can only enter via a
 * hand/agent-authored manifest — sanitise those on ingest.
 */
const CODE_EXEC_TOOLS = new Set([RUN_SCRIPT_TOOL_NAME, "bash"]);

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


