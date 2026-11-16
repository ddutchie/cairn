/**
 * Per-session engine state: one `Map<string, SessionState>`, keyed by session
 * id. (F5/B4: split out of `electron/ipc/engine-bridge.ts`; that file
 * re-exports the public surface.)
 *
 * There is one place to see what the engine remembers per session, and one
 * place that drops it. `forgetSessionState()` drops a session and its
 * `.sub-*` children; `forgetEngineSession()` in `host.ts` calls it when a
 * session is closed, cleared or destroyed. No other module keeps a
 * session-keyed map.
 */
import type { HostSend } from "../../agent/host";
import type { Profile } from "../../agent/loop";
import type { PermissionPreset } from "../../agent/profiles";
import type { ModelRoute } from "../../agent/provider";
import type { Rule } from "../../agent/rules";
import type { AgentTool } from "../../agent/tool-types";

export interface UsageMeta { source: "chat" | "coding" | "automation" | "writing-style"; workspaceId: string; projectId?: string; provider?: string; model: string; baseUrl: string }

export interface PendingQuestion { nonce: string; questions: unknown; resolve(answers: string): void; reject(err: Error): void }

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

export interface SessionState {
  /** The last turn ran in plan mode, so the next execute turn says that it ended. */
  planning: boolean;
  /** Per-session permission preset, chosen in the session header. */
  preset?: PermissionPreset;
  /** Workspace the session's file grants are scoped to, if it has one. */
  workspaceId?: string;
  /** Standing rules for this session (chat policy, restored grants). */
  rules?: Rule[];
  /** Where an automation's or wizard's events go instead of the renderer. */
  tap?: HostSend;
  /** What the usage recorder bills this session's turns to. */
  usage?: UsageMeta;
  /** Files the shell tool has touched, for the watcher. */
  observed?: Set<string>;
  /** Outstanding `ask_questions` cards, by tool call id. */
  questions: Map<string, PendingQuestion>;
  /** What a spawned subagent inherits, kept after the turn. */
  spawn?: SpawnContext;
}

const states = new Map<string, SessionState>();

export function getSessionState(sessionId: string): SessionState | undefined {
  return states.get(sessionId);
}

export function ensureSessionState(sessionId: string): SessionState {
  let st = states.get(sessionId);
  if (!st) {
    st = { planning: false, questions: new Map() };
    states.set(sessionId, st);
  }
  return st;
}

export function hasSessionState(sessionId: string): boolean {
  return states.has(sessionId);
}

/** Every live session id, for tests. */
export function sessionStateIds(): string[] {
  return [...states.keys()];
}

/**
 * Drop everything remembered for a session and its `.sub-*` children.
 * Pending questions are rejected so a reloading renderer does not wait on them.
 * Idle sessions keep their state; only closing, clearing, destroying and
 * shutdown paths call this.
 */
export function forgetSessionState(sessionId: string): void {
  const prefix = `${sessionId}.sub-`;
  for (const [key, st] of [...states]) {
    if (key !== sessionId && !key.startsWith(prefix)) continue;
    for (const [callId, q] of st.questions) {
      st.questions.delete(callId);
      try { q.reject(new Error("cancelled")); } catch { /* already settled */ }
    }
    states.delete(key);
  }
}
