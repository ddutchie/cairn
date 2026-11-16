/**
 * Per-session engine state, keyed by session id. (F5/B4: split out of
 * `electron/ipc/engine-bridge.ts`; that file re-exports the public surface.)
 *
 * Every module-level session map lives here so there is one place to see what
 * the engine remembers per session.
 */
import type { HostSend } from "../../agent/host";
import type { Profile } from "../../agent/loop";
import type { PermissionPreset } from "../../agent/profiles";
import type { ModelRoute } from "../../agent/provider";
import type { Rule } from "../../agent/rules";
import type { AgentTool } from "../../agent/tools";

/** Sessions whose last turn ran in plan mode, so the next execute turn can say that it ended. */
export const sessionPlanning = new Set<string>();

// ── permission presets (per session) ─────────────────────────────────────

export const sessionPreset = new Map<string, PermissionPreset>();

// ── singleton host ───────────────────────────────────────────────────────

export const sessionWorkspace = new Map<string, string>();
export const sessionRules = new Map<string, Rule[]>();
export const sessionTaps = new Map<string, HostSend>();
export interface UsageMeta { source: "chat" | "coding" | "automation" | "writing-style"; workspaceId: string; projectId?: string; provider?: string; model: string; baseUrl: string }
export const usageMeta = new Map<string, UsageMeta>();
export const observedFiles = new Map<string, Set<string>>();

export interface PendingQuestion { nonce: string; questions: unknown; resolve(answers: string): void; reject(err: Error): void }
export const pendingQuestions = new Map<string, PendingQuestion>();
export const qKey = (sessionId: string, callId: string): string => `${sessionId}::${callId}`;

// ── subagents ────────────────────────────────────────────────────────────

/** What a child needs from its parent, kept after the turn so the human can message a child later. */
export interface SpawnContext {
  cwd: string;
  profile: Profile;
  route: ModelRoute;
  systemPrompt: string;
  /** Read when a child starts: the tools its parent has at that moment. */
  tools: () => readonly AgentTool[];
  reasoningEffort?: string;
  temperature?: number;
  maxSteps?: number;
}
export const spawnContexts = new Map<string, SpawnContext>();
