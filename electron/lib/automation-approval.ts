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

/**
 * Build the approval gate for an automation. Returns undefined when there is
 * nothing to gate.
 *
 *   - 'ask' mode (regardless of requires): every non-read tool parks a durable
 *     approval item and blocks until the user resolves it.
 *   - 'auto' mode + a connector-aware automation (declares `requires`): external
 *     MCP/service tool calls are STILL gated behind the approval inbox — external
 *     side effects are never auto-approved. Built-in data tools run freely.
 *
 * Denied/timeout fail closed.
 */
export function makeApprovalGate(db: Database.Database, run: AutomationRun, automation: Automation): ApprovalGate | undefined {
  const connectorAware = (automation.requires ?? []).length > 0;
  const gateAllWrites = automation.approvalMode === "ask";
  const gateExternalOnly = !gateAllWrites && connectorAware;
  if (!gateAllWrites && !gateExternalOnly) {
    return undefined;
  }
  return async (name: string, args: Record<string, unknown>): Promise<{ allow: boolean; reason?: string }> => {
    if (isReadTool(name)) return { allow: true };
    // In auto mode only EXTERNAL tools are gated — built-in data tools (the
    // data-only toolset) still run freely.
    if (gateExternalOnly && !isExternalTool(name)) return { allow: true };
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
  };
}
