/**
 * decide(): the pure, synchronous permission pipeline.
 * See docs/plans/agent-engine-design.md §4.
 *
 *  1 profile hard-deny      → deny
 *  2 plan mode              → deny anything not READ (enforced, not advisory)
 *  3 deny rules             → deny
 *  4 doom-loop              → ask (human only; never auto-allowed or reviewed)
 *  5 protected paths        → ask, unless a non-preset allow rule covers it
 *  6 ask rules              → ask (human only)
 *  7 allow rules            → allow
 *  8 READ                   → allow
 *  9 unresolved             → by mode: ask | review (auto) | allow (yolo)
 *
 * Doom-loop sits above every allow so a granted tool cannot spin forever, and
 * it is evaluated before any ask short-circuit (audit gap G3).
 */
import { findRule, isProtectedPath, type CallView, type Rule } from "./rules";
import type { DecisionSource } from "./events";

export type Mode = "ask" | "auto" | "yolo" | "plan";

export interface PolicyState {
  mode: Mode;
  /** Tool names this profile never has (e.g. chat has no `bash`). */
  deniedTools: readonly string[];
  rules: readonly Rule[];
  workspaceRoot: string;
  protectedPaths?: readonly string[];
  /** Signatures of earlier calls this turn, oldest first. */
  recent: readonly string[];
  /** Signatures a human already allowed through the doom-loop pause. */
  doomAcked: ReadonlySet<string>;
  doomThreshold?: number;
  now?: number;
}

export type Decision =
  | { kind: "allow"; by: DecisionSource; ruleId?: string; reason?: string }
  | { kind: "deny"; by: DecisionSource; reason: string; ruleId?: string }
  | { kind: "ask"; by: DecisionSource; reason: string; ruleId?: string }
  | { kind: "review"; reason: string };

export const DOOM_THRESHOLD = 3;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = canonicalize((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function callSignature(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(canonicalize(args))}`;
}

function trailingRepeats(recent: readonly string[], sig: string): number {
  let n = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i] === sig; i--) n++;
  return n;
}

export function decide(call: CallView, signature: string, state: PolicyState): Decision {
  const ctx = { workspaceRoot: state.workspaceRoot, now: state.now };
  const risk = call.risk.class;

  if (state.deniedTools.includes(call.name)) {
    return { kind: "deny", by: "profile", reason: `${call.name} is not available in this profile` };
  }
  if (state.mode === "plan" && risk !== "READ") {
    return { kind: "deny", by: "plan", reason: "Plan mode is read-only; exit plan mode to make changes" };
  }

  const denyRule = findRule(state.rules, call, ctx, ["deny"]);
  if (denyRule) return { kind: "deny", by: "rule", ruleId: denyRule.id, reason: denyRule.note ?? `Denied by rule ${denyRule.id}` };

  const threshold = state.doomThreshold ?? DOOM_THRESHOLD;
  if (!state.doomAcked.has(signature) && trailingRepeats(state.recent, signature) >= threshold - 1) {
    return { kind: "ask", by: "doom", reason: `Repeated identical ${call.name} call ${threshold} times in a row` };
  }

  const allowRule = findRule(state.rules, call, ctx, ["allow"]);

  if (risk !== "READ" && call.risk.paths?.some((p) => isProtectedPath(p, state.workspaceRoot, state.protectedPaths))) {
    // Presets never reach protected paths; only an explicit user decision does.
    const explicit = findRule(state.rules, call, ctx, ["allow"], (r) => r.source !== "preset");
    if (explicit) return { kind: "allow", by: "rule", ruleId: explicit.id };
    return { kind: "ask", by: "protected", reason: "Touches a protected path (credentials, git, shell config or Cairn config)" };
  }

  const askRule = findRule(state.rules, call, ctx, ["ask"]);
  if (askRule) return { kind: "ask", by: "rule", ruleId: askRule.id, reason: askRule.note ?? `Rule ${askRule.id} requires approval` };

  if (allowRule) return { kind: "allow", by: "rule", ruleId: allowRule.id };
  if (risk === "READ") return { kind: "allow", by: "default" };

  switch (state.mode) {
    case "yolo": return { kind: "allow", by: "mode", reason: "auto-approve is on" };
    case "auto": return { kind: "review", reason: "No rule covers this call" };
    default: return { kind: "ask", by: "mode", reason: "No rule covers this call" };
  }
}
