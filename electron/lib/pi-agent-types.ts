/**
 * pi-agent-types — shared types for the coding agent.
 *
 * `electron/ipc/pi-agent.ts` and the Cordis coding runner
 * (`run-cordis-coding.ts`) share these stable shapes.
 */

import type { BrowserWindow } from "electron";
import type { ChatRequest } from "./tools";
import type { SkillMeta } from "./skills";
import type Database from "better-sqlite3";

/** LLM configuration for a coding-agent turn. */
export interface AgentLLMConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Maximum tool-call iterations per turn. Defaults to 20. */
  maxSteps: number;
  /** Sampling temperature. Undefined = omit (vendor default). */
  temperature?: number;
  /** Maximum automatic retries on transient errors (429/5xx). Defaults to 3. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Defaults to 2000. */
  baseRetryDelayMs?: number;
  /** Model context window size in tokens. Defaults to 128000. */
  contextWindow?: number;
  /** Whether to automatically approve tool calls or prompt the user. */
  autoApprove?: boolean;
  /** Max output tokens per turn. Undefined/0 → Auto. */
  maxTokens?: number;
  /** Whether the selected model is a reasoning/thinking model. */
  isReasoningModel?: boolean;
  /** Provider slug (e.g. "openai", "localllm"). */
  provider?: string;
}

// ── Per-session infrastructure context ───────────────────────────────────────

export interface AgentToolContext {
  cwd: string;
  db: Database.Database;
  req: ChatRequest;
  workspacePath: string;
  sessionId: string;
  send: (channel: string, payload: unknown) => void;
  getWin?: () => BrowserWindow | null;
  skills?: SkillMeta[];
}

// ── Session state ─────────────────────────────────────────────────────────────

export type AgentSessionRole = "default" | "automation-dev";

export interface AgentSession {
  abortCtrl: AbortController;
  role?: AgentSessionRole;
}
