/**
 * Approval Mode — OpenWorker-inspired gating for tool execution.
 *
 * Replaces the legacy binary `autoApprove: boolean` with a 5-class Mode that
 * consults the Risk taxonomy (READ|WRITE_LOCAL|EXEC|EXTERNAL) per-tool.
 *
 * Mapping keeps backward compat: autoApprove:true → "auto", false → "interactive"
 * so existing stored configs and callers default identically. EXTERNAL always asks
 * regardless of mode (see shouldAskForRisk).
 *
 * Pure data + pure functions: no Electron/Node APIs — importable from renderer,
 * main, and tests.
 */
import type { RiskClass } from "./tool-risk";
import { riskForTool } from "./tool-risk";

export type Mode = "discuss" | "plan" | "interactive" | "auto" | "custom";

export const MODES: readonly Mode[] = ["discuss", "plan", "interactive", "auto", "custom"] as const;

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/**
 * Map the legacy boolean toggle to a Mode so behaviour is preserved:
 *  true  → "auto"        (everything auto-allowed except EXTERNAL)
 *  false → "interactive" (every mutating tool asks)
 *  undefined → "interactive" (conservative default — matches DEFAULT_AGENT_CONFIG.autoApprove=false)
 * Callers whose previous default was "auto when absent" (e.g. runCordisCodingLoop)
 * should pass their own default; the helper does not encode that policy.
 */
export function modeFromAutoApprove(autoApprove?: boolean): Mode {
  return autoApprove ? "auto" : "interactive";
}

export function autoApproveFromMode(mode: Mode): boolean {
  return mode === "auto";
}

/**
 * Resolve the effective Mode from a config that may carry either/both shapes.
 * Explicit `mode` wins; otherwise derive from `autoApprove` if present;
 * otherwise fall back to the supplied default (defaults to "interactive").
 */
export function resolveMode(input: { mode?: Mode; autoApprove?: boolean }, fallback: Mode = "interactive"): Mode {
  if (input.mode && isMode(input.mode)) return input.mode;
  if (typeof input.autoApprove === "boolean") return modeFromAutoApprove(input.autoApprove);
  return fallback;
}

/**
 * Does this risk class require user confirmation under the given Mode?
 * EXTERNAL always asks — even in "auto". Every other non-READ asks in every
 * mode except "auto".
 */
export function shouldAskForRisk(risk: RiskClass, mode: Mode): boolean {
  if (risk === "EXTERNAL") return true;
  if (mode === "auto") return false;
  // discuss / plan / interactive / custom: every mutating class asks.
  return risk !== "READ";
}

/**
 * Mode-aware per-tool gate. Combines the risk taxonomy with the active Mode,
 * and respects read-only invocations of multiplexed tools (str_replace_editor view).
 * Mirrors the old `needsApprovalForCall` policy, but MODE-scoped instead of binary.
 */
export function shouldAskForTool(name: string, mode: Mode, args: Record<string, unknown> = {}): boolean {
  // str_replace_editor view is read-only → map to READ regardless of mode.
  if (name === "str_replace_editor" && args.command === "view") return false;
  const risk = riskForTool(name);
  return shouldAskForRisk(risk, mode);
}

/**
 * Legacy alias: shouldAskForMode respects the old autoApprove boolean surface
 * by mapping it to a Mode. Prefer shouldAskForTool directly.
 */
export function shouldAskForToolWithAutoApprove(name: string, autoApprove: boolean, args: Record<string, unknown> = {}): boolean {
  return shouldAskForTool(name, modeFromAutoApprove(autoApprove), args);
}
