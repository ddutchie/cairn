/**
 * Approval Mode — OpenWorker-inspired gating for tool execution.
 *
 * Replaces the legacy binary `autoApprove: boolean` with a 5-class ApprovalMode that
 * consults the Risk taxonomy (READ|WRITE_CAIRN|WRITE_LOCAL|EXEC|EXTERNAL) per-tool.
 *
 * Mapping keeps backward compat: autoApprove:true → "auto", false → "interactive"
 * so existing stored configs and callers default identically. EXTERNAL always asks
 * regardless of mode (see shouldAskForRisk).
 *
 * Pure data + pure functions: no Electron/Node APIs — importable from renderer,
 * main, and tests.
 */
import type { RiskClass } from "./risk";
import { riskForCall } from "./tool-risk";

export type ApprovalMode = "discuss" | "plan" | "interactive" | "auto" | "custom";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["discuss", "plan", "interactive", "auto", "custom"] as const;

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

/**
 * Map the legacy boolean toggle to an ApprovalMode so behaviour is preserved:
 *  true  → "auto"        (everything auto-allowed except EXTERNAL)
 *  false → "interactive" (every mutating tool asks)
 *  undefined → "interactive" (conservative default — matches DEFAULT_AGENT_CONFIG.autoApprove=false)
 * Callers whose previous default was "auto when absent" (e.g. runEngineCodingLoop)
 * should pass their own default; the helper does not encode that policy.
 */
export function approvalModeFromAutoApprove(autoApprove?: boolean): ApprovalMode {
  return autoApprove ? "auto" : "interactive";
}

export function autoApproveFromMode(mode: ApprovalMode): boolean {
  return mode === "auto";
}

/**
 * Resolve the effective ApprovalMode from a config that may carry either/both shapes.
 * Explicit `mode` wins; otherwise derive from `autoApprove` if present;
 * otherwise fall back to the supplied default (defaults to "interactive").
 */
export function resolveApprovalMode(input: { mode?: ApprovalMode; autoApprove?: boolean }, fallback: ApprovalMode = "interactive"): ApprovalMode {
  if (input.mode && isApprovalMode(input.mode)) return input.mode;
  if (typeof input.autoApprove === "boolean") return approvalModeFromAutoApprove(input.autoApprove);
  return fallback;
}

/**
 * Does this risk class require user confirmation under the given ApprovalMode?
 * EXTERNAL always asks — even in "auto". Every other non-READ asks in every
 * mode except "auto".
 */
export function shouldAskForRisk(risk: RiskClass, mode: ApprovalMode): boolean {
  if (risk === "EXTERNAL") return true;
  if (mode === "auto") return false;
  // discuss / plan / interactive / custom: every mutating class asks.
  return risk !== "READ";
}

/**
 * Mode-aware per-tool gate. Combines the risk taxonomy with the active ApprovalMode.
 * (The retired `str_replace_editor` view carve-out was removed in Q6.)
 * Mirrors the old `needsApprovalForCall` policy, but MODE-scoped instead of binary.
 */
export function shouldAskForTool(name: string, mode: ApprovalMode, args: Record<string, unknown> = {}): boolean {
  const risk = riskForCall(name, args);
  return shouldAskForRisk(risk, mode);
}

/**
 * Legacy alias: shouldAskForMode respects the old autoApprove boolean surface
 * by mapping it to an ApprovalMode. Prefer shouldAskForTool directly.
 */
export function shouldAskForToolWithAutoApprove(name: string, autoApprove: boolean, args: Record<string, unknown> = {}): boolean {
  return shouldAskForTool(name, approvalModeFromAutoApprove(autoApprove), args);
}
