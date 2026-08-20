/**
 * pi-agent-types — shared types for the coding agent (Phase 2c).
 *
 * Extracted from the (now-deleted) `electron/lib/pi-agent-loop.ts` so the
 * frozen builtin loop file could be removed while `electron/ipc/pi-agent.ts`
 * and the Cordis loop keep using these stable shapes. The Cordis engine
 * (`run-cordis-coding.ts`) is the only runtime now; the builtin `runAgentLoop`
 * that consumed these is gone.
 */

import type { BrowserWindow } from "electron";
import type { ContentPart } from "../../shared/models/pdf-attach";
import type { ChatRequest, ToolArgs } from "./tools";
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

// ── Message types ─────────────────────────────────────────────────────────────

export interface AgentUserMessage    { role: "user";      content: string | ContentPart[] }
export interface AgentAssistantMsg   { role: "assistant"; content: string | null; reasoning?: string; reasoningField?: string; reasoningModel?: string; reasoningItems?: Array<Record<string, unknown>>; tool_calls?: ToolCallSpec[] }
export interface AgentToolResultMsg  { role: "tool";      tool_call_id: string; content: string }

export type AgentMessage =
  | AgentUserMessage
  | AgentAssistantMsg
  | AgentToolResultMsg;

export interface ToolCallSpec {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  thought_signature?: string;
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

export interface PiAgentSession {
  messages: AgentMessage[];
  abortCtrl: AbortController;
  role?: AgentSessionRole;
  lastPromptTokens?: number;
  totalCompletionTokens?: number;
  totalReasoningTokens?: number;
  compactionTransformer?: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>;
  approvedTools?: Set<string>;
  recentToolCalls?: string[];
  doomLoopApproved?: boolean;
}

export type ApprovalDecision = { approved: boolean; grant?: "session" | "command" };
