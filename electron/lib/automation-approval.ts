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
  parkApproval,
  resolveApproval,
  type ApprovalItem,
  type ApprovalResolution,
} from "../db/approval-queries";
import { getAutomationById, getAutomationRunById, updateAutomation, type Automation, type AutomationRun } from "../db/automation-queries";
import { RUN_SCRIPT_TOOL_NAME } from "./automation-script";

/** How long a parked approval waits for a user decision before failing closed. */
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;
export const APPROVAL_POLL_MS = 1_000;

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

export function waitForApproval(
  db: Database.Database,
  itemId: string,
  timeoutMs = APPROVAL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ApprovalResolution | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let timer: NodeJS.Timeout | null = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      // Fail closed: an aborted run (app quit, destroy) must not leave the item
      // parked — the heartbeat sweep marks it expired shortly after anyway.
      try { resolveApproval(db, itemId, "denied"); } catch { /* ignore */ }
      resolve(null);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const poll = () => {
      let item: ApprovalItem | null = null;
      try {
        item = getApprovalItemById(db, itemId);
      } catch { /* db transient */ }
      if (item && item.state === "resolved" && item.resolution) {
        signal?.removeEventListener("abort", onAbort);
        resolve(item.resolution);
        return;
      }
      if (item && item.state === "expired") {
        signal?.removeEventListener("abort", onAbort);
        resolve(null);
        return;
      }
      if (Date.now() >= deadline) {
        // Fail closed on timeout.
        try { resolveApproval(db, itemId, "denied"); } catch { /* ignore */ }
        signal?.removeEventListener("abort", onAbort);
        resolve(null);
        return;
      }
      timer = setTimeout(poll, APPROVAL_POLL_MS);
    };
    poll();
  });
}

export type ApprovalGate = (name: string, args: Record<string, unknown>) => Promise<{ allow: boolean; reason?: string }>;

/** Park an approval item, notify, and block until the user (or timeout) resolves it. */
async function parkAndWait(
  db: Database.Database,
  run: AutomationRun,
  automation: Automation,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ allow: boolean; reason?: string }> {
  const item = parkApproval(db, {
    runId: run.id,
    sessionId: run.id,
    tool: name,
    args,
    kind: "approval",
    title: `Automation "${automation.name}"`,
    body: `Run of "${automation.name}" wants to call ${name} — approve or deny?`,
  });
  insertNotification(
    db,
    "automation_approval",
    `Approval needed: "${automation.name}"`,
    `Run wants to ${name}. Approve or deny below.`,
    { type: "approval", id: item.id },
  );
  const resolution = await waitForApproval(db, item.id, undefined, signal);
  if (resolution === null) {
    return { allow: false, reason: "Approval request expired (denied by timeout)." };
  }
  if (resolution === "denied") {
    return { allow: false, reason: "Blocked: user denied this action." };
  }
  return { allow: true };
}

/**
 * Build the approval gate for an automation.
 *
 *   - `run_script` (EXEC) is ALWAYS gated — in every mode — because a script
 *     is an arbitrary executable; the only shortcut is a script-scoped
 *     standing rule ({ tool: "run_script", target: "generate_images" }).
 *   - 'ask' mode: every non-read tool parks an approval and blocks.
 *   - 'auto' mode + connector-aware automation: external MCP/service calls are
 *     still gated — external side effects are never auto-approved. Built-in
 *     data tools run freely.
 *
 * A gate is always returned (run_script can be called by any automation), so
 * the loop always executes tool calls sequentially for automation runs.
 * Denied/timeout fail closed.
 */
export function makeApprovalGate(db: Database.Database, run: AutomationRun, automation: Automation, signal?: AbortSignal): ApprovalGate {
  const connectorAware = (automation.requires ?? []).length > 0;
  const gateAllWrites = automation.approvalMode === "ask";
  const gateExternalOnly = !gateAllWrites && connectorAware;
  const standingRuleAllows = (tool: string, target?: string) =>
    automation.standingRules.some((r) => r.tool === tool && (r.target === undefined || r.target === target));

  return async (name: string, args: Record<string, unknown>): Promise<{ allow: boolean; reason?: string }> => {
    if (isReadTool(name)) return { allow: true };
    // A standing rule ("always allow") is the shortcut for any tool — e.g.
    // run_script:generate_images, create_task, bash:<exact command>. These are
    // persisted by the approval inbox's "Always allow" resolution.
    if (standingRuleAllows(name, standingRuleTarget(name, args))) return { allow: true };
    if (name === RUN_SCRIPT_TOOL_NAME) {
      return parkAndWait(db, run, automation, name, args, signal);
    }
    // 'ask' mode gates every write; 'auto' mode only gates external MCP/service
    // calls when the automation is connector-aware. Built-in data tools run
    // freely in auto mode.
    if (gateAllWrites) return parkAndWait(db, run, automation, name, args, signal);
    if (gateExternalOnly && isExternalTool(name)) return parkAndWait(db, run, automation, name, args, signal);
    return { allow: true };
  };
}
