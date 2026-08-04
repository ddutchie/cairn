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
 * Build the approval gate for an automation. Returns undefined in 'auto' mode
 * (run freely) or for read-only-only concerns. In 'ask' mode, write tools park
 * a durable approval item (idempotent per run+tool+args) and block until the
 * user resolves it; denied/timeout fail closed.
 */
export function makeApprovalGate(db: Database.Database, run: AutomationRun, automation: Automation): ApprovalGate | undefined {
  if (automation.approvalMode !== "ask") {
    return undefined;
  }
  return async (name: string, args: Record<string, unknown>): Promise<{ allow: boolean; reason?: string }> => {
    if (isReadTool(name)) return { allow: true };
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
