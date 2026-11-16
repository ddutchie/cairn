/**
 * UI approval mode → engine policy profile.
 *
 * Single home for the three translations that used to live as separate helpers
 * in `electron/ipc/engine-bridge.ts` (`engineProfile`, `presetFromApprovalMode`,
 * `presetProfile`): they all funnel through `toPolicyMode()`.
 * Persisted strings are unchanged — only identifiers were renamed
 * (`Mode` → `PolicyMode` on the engine side, `Mode` → `ApprovalMode` on the UI side).
 */
import type { Profile } from "./loop";
import type { PolicyMode } from "./policy";
import type { ApprovalMode } from "../../shared/agent/approval-mode";
import type { ChatApprovalPolicy } from "../../shared/agent/chat-approval";
import type { Rule } from "./rules";

/** The one ApprovalMode → PolicyMode translation. `auto` keeps its legacy meaning: allow everything except EXTERNAL. */
export function toPolicyMode(mode: ApprovalMode | undefined): PolicyMode {
  if (mode === "discuss" || mode === "plan") return "plan";
  if (mode === "auto") return "yolo";
  return "ask";
}

/** Legacy approval modes onto engine modes. */
export function engineProfile(mode: ApprovalMode | undefined, role: "default" | "automation-dev" | undefined): Profile {
  const policyMode = toPolicyMode(mode);
  return {
    id: role === "automation-dev" ? "automation-dev" : "coding",
    interactive: true,
    mode: policyMode,
    externalAlwaysAsks: policyMode === "yolo",
  };
}

// ── permission presets (per session) ─────────────────────────────────────────

export const PERMISSION_PRESETS = [
  { value: "ask", name: "Ask", description: "Ask before anything that changes files, runs commands, or calls external tools." },
  { value: "auto", name: "Auto", description: "A model reviews each risky action: routine ones run, dangerous ones are blocked, unclear ones ask you. External tool calls still ask." },
  { value: "yolo", name: "Allow all", description: "Run everything without asking, except external tool calls, which still ask." },
] as const;
export type PermissionPreset = typeof PERMISSION_PRESETS[number]["value"];

/** The legacy approval mode a session would start with, as a preset. */
export function presetFromApprovalMode(mode: ApprovalMode | undefined): PermissionPreset {
  return mode === "auto" ? "yolo" : "ask";
}

/**
 * Layer a per-session permission preset over the base profile. Pure: the caller
 * passes the session's current preset (if any) instead of a session id + map.
 */
export function presetProfile(
  preset: PermissionPreset | undefined,
  mode: ApprovalMode | undefined,
  role: "default" | "automation-dev" | undefined,
): Profile {
  const base = engineProfile(mode, role);
  if (!preset || base.mode === "plan") return base;
  return { ...base, mode: preset, externalAlwaysAsks: preset === "yolo" };
}

/**
 * Chat approvals as engine policy. `safe` asks for deletes (WRITE_LOCAL) and connector calls (EXTERNAL)
 * simply because nothing allows them; `external` adds an allow for deletes; `allow-all` is yolo.
 * Grants stay overridable, which an `ask` rule would not be.
 */
export function chatEngineProfile(policy: ChatApprovalPolicy): { profile: Profile; rules: Rule[] } {
  const rules: Rule[] = policy === "external"
    ? [{ id: "policy:chat-external-delete", effect: "allow", scope: "global", source: "preset", match: { tool: "delete" }, note: "Chat policy: external approve" }]
    : [];
  return { profile: { id: "chat", interactive: true, mode: policy === "allow-all" ? "yolo" : "ask" }, rules };
}
