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
import type { Automation, AutomationRun } from "../db/automation-queries";
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

export function waitForApproval(db: Database.Database, itemId: string, timeoutMs = APPROVAL_TIMEOUT_MS): Promise<ApprovalResolution | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      let item: ApprovalItem | null = null;
      try {
        item = getApprovalItemById(db, itemId);
      } catch { /* db transient */ }
      if (item && item.state === "resolved" && item.resolution) {
        resolve(item.resolution);
        return;
      }
      if (item && item.state === "expired") {
        resolve(null);
        return;
      }
      if (Date.now() >= deadline) {
        // Fail closed on timeout.
        try { resolveApproval(db, itemId, "denied"); } catch { /* ignore */ }
        resolve(null);
        return;
      }
      setTimeout(poll, APPROVAL_POLL_MS);
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
  const resolution = await waitForApproval(db, item.id);
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
export function makeApprovalGate(db: Database.Database, run: AutomationRun, automation: Automation): ApprovalGate {
  const connectorAware = (automation.requires ?? []).length > 0;
  const gateAllWrites = automation.approvalMode === "ask";
  const gateExternalOnly = !gateAllWrites && connectorAware;
  const standingRuleAllows = (tool: string, target?: string) =>
    automation.standingRules.some((r) => r.tool === tool && (r.target === undefined || r.target === target));

  return async (name: string, args: Record<string, unknown>): Promise<{ allow: boolean; reason?: string }> => {
    if (isReadTool(name)) return { allow: true };
    if (name === RUN_SCRIPT_TOOL_NAME) {
      const scriptName = typeof args.name === "string" ? args.name : undefined;
      if (scriptName && standingRuleAllows(RUN_SCRIPT_TOOL_NAME, scriptName)) return { allow: true };
      return parkAndWait(db, run, automation, name, args);
    }
    // 'ask' mode gates every write; 'auto' mode only gates external MCP/service
    // calls when the automation is connector-aware. Built-in data tools run
    // freely in auto mode.
    if (gateAllWrites) return parkAndWait(db, run, automation, name, args);
    if (gateExternalOnly && isExternalTool(name)) return parkAndWait(db, run, automation, name, args);
    return { allow: true };
  };
}
