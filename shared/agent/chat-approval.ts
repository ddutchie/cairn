/**
 * Chat approval policy — what the chat assistant must ask before running.
 *
 * Chat has no sandbox (unlike coding sessions, whose permission preset is the
 * guard), so its policy is chosen per tool class:
 *
 *   - "safe"      → deletes (notes/tasks/projects), connectors (MCP/service)
 *                   and shell-capable delegation ask. Everything else runs.
 *   - "external"  → connectors and shell-capable delegation ask; Cairn data
 *                   tools, deletes included, always run.
 *   - "allow-all" → nothing asks (auto-approve).
 *
 * Pure data + functions: importable from renderer, main, and tests.
 */
import { riskForTool, type RiskClass } from "./tool-risk";

export type ChatApprovalPolicy = "safe" | "external" | "allow-all";

export const DEFAULT_CHAT_APPROVAL_POLICY: ChatApprovalPolicy = "safe";

export const CHAT_APPROVAL_OPTIONS: ReadonlyArray<{ value: ChatApprovalPolicy; label: string; description: string }> = [
  { value: "safe", label: "Safe", description: "Asks before deleting notes, tasks or projects, and before connector calls." },
  { value: "external", label: "External approve", description: "Cairn tools always run; asks before connector calls." },
  { value: "allow-all", label: "Allow everything", description: "Never asks — every tool, including connectors, runs automatically." },
];

/** Cairn deletions gated under "safe". */
export const CHAT_DELETE_TOOLS: ReadonlySet<string> = new Set(["delete_note", "delete_task", "delete_project"]);

export function isChatApprovalPolicy(value: unknown): value is ChatApprovalPolicy {
  return value === "safe" || value === "external" || value === "allow-all";
}

/** Resolve a stored/received value to a policy (unknown → the default). */
export function resolveChatApprovalPolicy(value: unknown): ChatApprovalPolicy {
  return isChatApprovalPolicy(value) ? value : DEFAULT_CHAT_APPROVAL_POLICY;
}

/** Does a chat call to `name` need approval under `policy`? */
export function chatToolNeedsApproval(name: string, policy: ChatApprovalPolicy): boolean {
  if (policy === "allow-all") return false;
  const risk: RiskClass = riskForTool(name);
  if (risk === "EXTERNAL" || risk === "EXEC") return true;
  return policy === "safe" && CHAT_DELETE_TOOLS.has(name);
}
