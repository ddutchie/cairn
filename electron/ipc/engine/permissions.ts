/**
 * Permission presets, chat policy and grant rules. (F5/B4: split out of
 * `electron/ipc/engine-bridge.ts`; no logic changes.)
 */
import { broadcastEvent } from "../registry";
import type { Profile } from "../../agent/loop";
import {
  PERMISSION_PRESETS,
  presetProfile as purePresetProfile,
  presetFromApprovalMode,
  type PermissionPreset,
} from "../../agent/profiles";
import { canonicalCommand, type Rule } from "../../agent/rules";
import { getCachedConfig } from "../../lib/config-cache";
import { buildSystemPrompt, withPersonality, type ChatRequest } from "../../lib/tools";
import type { ApprovalMode } from "../../../shared/agent/approval-mode";
import { resolveChatApprovalPolicy, type ChatApprovalPolicy } from "../../../shared/agent/chat-approval";
import { makeSessionProjection } from "../../../shared/agent/session-projection";
import { ensureSessionState, getSessionState } from "./session-state";

export { PERMISSION_PRESETS };

export function presetProfile(sessionId: string, mode: ApprovalMode | undefined, role: "default" | "automation-dev" | undefined): Profile {
  return purePresetProfile(getSessionState(sessionId)?.preset, mode, role);
}

export function readEnginePermissions(sessionId: string, fallback: ApprovalMode | undefined): { options: Array<{ value: string; name: string; description?: string }>; currentValue: string } {
  return { options: PERMISSION_PRESETS.map((p) => ({ ...p })), currentValue: getSessionState(sessionId)?.preset ?? presetFromApprovalMode(fallback) };
}

export function setEnginePermission(sessionId: string, preset: string, fallback: ApprovalMode | undefined): { options: Array<{ value: string; name: string; description?: string }>; currentValue: string } {
  if (!PERMISSION_PRESETS.some((p) => p.value === preset)) throw Object.assign(new Error(`Unknown permission preset: ${preset}`), { code: "bad-request" });
  ensureSessionState(sessionId).preset = preset as PermissionPreset;
  const view = readEnginePermissions(sessionId, fallback);
  broadcastEvent("session:projection", makeSessionProjection(sessionId, "permissions", view));
  return view;
}

export function chatSystemPrompt(req: ChatRequest, policy: ChatApprovalPolicy): string {
  const base = withPersonality(buildSystemPrompt(req), req.personality);
  if (policy === "allow-all") return base;
  return `${base}\n\n## Tool approvals\nExternal tools (like web search via Tavily)${policy === "safe" ? " and destructive operations" : ""} require user approval. To use them, simply call the tool — the system will automatically show an approval card to the user and pause your turn until they respond. Do NOT ask for permission in your text and do NOT use ask_questions to request approval. Just call the tool.`;
}

export const chatApprovalPolicyFor = (req: ChatRequest): ChatApprovalPolicy =>
  resolveChatApprovalPolicy(req.approvalPolicy ?? (getCachedConfig().aiConfig as { chatApprovalPolicy?: unknown } | undefined)?.chatApprovalPolicy);

/** Tools whose saved grants reach files: they cover the session's code folder, never the whole disk. */
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);

export function grantsToRules(sessionId: string, grants: Array<{ id: string; tool: string; target: string | null }>): Rule[] {
  return grants.map((g) => ({
    id: `workspace:${g.id}`,
    effect: "allow" as const,
    scope: "workspace" as const,
    source: "grant" as const,
    // Only the tool and a command are stored, so a file-write grant is scoped again when it is loaded.
    match: g.target ? { tool: g.tool, command: { exact: canonicalCommand(g.target) } } : FILE_WRITE_TOOLS.has(g.tool) ? { tool: g.tool, path: { within: "workspace" as const } } : { tool: g.tool },
    note: `Workspace grant (${sessionId})`,
  }));
}
