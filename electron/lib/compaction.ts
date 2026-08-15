/**
 * LLM-based context compaction for long Pi-agent sessions.
 *
 * When the session's lastPromptTokens exceeds COMPACT_THRESHOLD of the model's
 * context window, the oldest messages are summarised with a single non-streaming
 * LLM call. The summary is injected back as a synthetic user message and the
 * trimmed messages are dropped from the context sent to the model.
 *
 * This does NOT mutate session.messages — it only transforms what is sent to
 * the LLM each turn (via the transformContext hook in AgentLoopCallbacks).
 * The full conversation history is always preserved in session storage.
 *
 * Compaction is skipped when:
 *   - lastPromptTokens is unknown (first turn)
 *   - The session is already compact (below threshold)
 *   - A compaction call is already in flight for this session
 *   - The compaction API call fails (falls back silently to the pruner)
 */

import type { AgentLLMConfig, AgentMessage, AgentToolResultMsg, PiAgentSession } from "./pi-agent-loop";
import { postChatCompletions, type OpenAIMessage } from "./llm";
import { recordLlmUsage, extractCost } from "./usage-recorder";
import { buildResponsesBody } from "./responses";
import { resolveTemperatureForModel } from "./model-pricing";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Start compacting when context reaches this fraction of the window. */
const COMPACT_THRESHOLD = 0.80;

/** Number of recent turns to preserve verbatim (not summarised). */
const KEEP_RECENT_TURNS = 6;

/** Max tokens to request for the summary itself. */
const SUMMARY_MAX_TOKENS = 4096;

/** Character budget per tool result included in the serialised conversation. */
const TOOL_RESULT_MAX_CHARS = 1500;

// ── Message serialisation ─────────────────────────────────────────────────────

function serializeMessages(messages: AgentMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : "";
      if (text) parts.push(`[User]: ${text}`);
    } else if (msg.role === "assistant") {
      if (msg.content) parts.push(`[Assistant]: ${msg.content}`);
      if (msg.tool_calls?.length) {
        const calls = msg.tool_calls.map((tc) => {
          let args = "";
          try { args = JSON.stringify(JSON.parse(tc.function.arguments), null, 0); } catch { args = tc.function.arguments; }
          return `${tc.function.name}(${args})`;
        });
        parts.push(`[Tool calls]: ${calls.join("; ")}`);
      }
    } else if (msg.role === "tool") {
      const result = msg as AgentToolResultMsg;
      const text = result.content.length > TOOL_RESULT_MAX_CHARS
        ? `${result.content.slice(0, TOOL_RESULT_MAX_CHARS)}…`
        : result.content;
      parts.push(`[Tool result]: ${text}`);
    }
  }

  return parts.join("\n\n");
}

// ── Split: what to summarise vs what to keep verbatim ────────────────────────

interface Split {
  toSummarise: AgentMessage[];
  toKeep: AgentMessage[];
}

function splitMessages(messages: AgentMessage[]): Split {
  // Walk backwards, count assistant turns to find the keep boundary
  let keptTurns = 0;
  let keepFromIdx = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      keptTurns++;
      keepFromIdx = i;
      if (keptTurns >= KEEP_RECENT_TURNS) break;
    }
  }

  return {
    toSummarise: messages.slice(0, keepFromIdx),
    toKeep:      messages.slice(keepFromIdx),
  };
}

// ── Summarisation LLM call ────────────────────────────────────────────────────

const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant. Your task is to read a conversation between a user " +
  "and an AI coding assistant, then produce a structured summary following the exact format specified. " +
  "Do NOT continue the conversation. Do NOT respond to any questions in the conversation. " +
  "ONLY output the structured summary.";

const SUMMARIZATION_USER_PROMPT = (conversationText: string) =>
  `<conversation>\n${conversationText}\n</conversation>

Produce a concise summary of the above conversation for use as context in a future AI coding session. Include:

1. **Goal** — What the user is trying to accomplish (1-2 sentences).
2. **Agreed Plan & Approvals** — The specific steps of the plan that was agreed upon, and any explicit user approvals or commands to proceed (e.g., "lets go", "continue").
3. **Progress** — What has been implemented or discovered so far. Reference specific files and functions where relevant.
4. **Key decisions** — Any important design choices or constraints identified.
5. **Modified files** — List every file that was created or changed.
6. **Current state** — Where things stand right now, what remains to be done, and what steps of the plan are currently being executed.
7. **Open issues** — Bugs, TODOs, or unresolved questions noted during the session.

Be specific. Cite file paths, function names, and line numbers where they matter. Omit pleasantries and filler.`;

export async function generateSummary(
  messages: AgentMessage[],
  llmConfig: AgentLLMConfig,
  signal: AbortSignal,
  attrib?: { sessionId?: string; projectId?: string; workspaceId?: string },
): Promise<string> {
  const conversationText = serializeMessages(messages);
  if (!conversationText.trim()) return "";

  const { baseUrl, model, apiKey } = llmConfig;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  // Resolve the wire protocol once (dynamic import avoids the compaction ↔
  // llm-transport cycle). Responses-capable providers use /v1/responses.
  const { resolveTransport, markCompletionsOnly, isEndpointNotFound, COMPLETIONS_TRANSPORT } = await import("./llm-transport");
  let transport = await resolveTransport(baseUrl, apiKey);

  const summaryMessages: OpenAIMessage[] = [
    { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
    { role: "user", content: SUMMARIZATION_USER_PROMPT(conversationText) },
  ];

  const buildBody = (reasoningEffort?: "none", minimal = false): Record<string, unknown> =>
    transport.mode === "responses"
      ? buildResponsesBody({
          model,
          messages: summaryMessages,
          maxTokens: SUMMARY_MAX_TOKENS,
          temperature: resolveTemperatureForModel(model, 0.1),
          reasoningEffort,
          stream: true,
          // A strict third-party Responses endpoint may reject `include` and
          // `temperature` — strip both on the minimal retry.
          ...(minimal ? { supportsEncryptedReasoning: false, includeTemperature: false } : {}),
        })
      : {
          model,
          // System prompt as a `role: "system"` message (not a top-level `system:`
          // field) so strict OpenAI-compatible providers don't reject the request
          // with "unknown parameter system".
          messages: summaryMessages,
          max_tokens: SUMMARY_MAX_TOKENS,
          temperature: resolveTemperatureForModel(model, 0.1), // deterministic summary
          // Must stream to prevent proxy connection drop timeouts (e.g. gateway/reverse proxy limits on blocking sync calls returning 504 Gateway Time-out)
          stream: true,
          // Summary is a direct transform — skip reasoning for ~2x speed, like the
          // writing-style one-shots.
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        };

  const doFetch = (b: Record<string, unknown>) =>
    transport.mode === "responses"
      ? fetch(transport.endpoint(baseUrl), { method: "POST", headers, signal, body: JSON.stringify(b) })
      : postChatCompletions(transport.endpoint(baseUrl), headers, b, true, signal);

  let response = await doFetch(buildBody("none"));
  // A strict endpoint may reject reasoning_effort (400/422) — retry without it
  // (and with the optional Responses `include`/`temperature` stripped) so
  // compaction never breaks for models that don't support the field.
  if (response.status === 400 || response.status === 422) {
    response = await doFetch(buildBody(undefined, true));
  }
  // A provider we (or the probe) thought spoke Responses returned 404/405 —
  // downgrade it to chat-completions and retry this summary once.
  if (!response.ok && transport.mode === "responses" && isEndpointNotFound(response.status)) {
    markCompletionsOnly(baseUrl);
    transport = COMPLETIONS_TRANSPORT;
    response = await doFetch(buildBody(undefined));
  }

  if (!response.ok) {
    throw new Error(`Compaction LLM call failed: ${response.status} ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response stream for compaction");

  let usage: { pt?: number; ct?: number; rt?: number; cacheRead?: number; cacheCreate?: number; chunkCost?: unknown; raw?: unknown } | undefined;
  // Consume via the shared buffered SSE parser (same as chat/agent/callLLM) —
  // the old inline split("\n")-per-chunk loop mangled records that straddled
  // TCP reads and ignored reasoning fields.
  const turn = await transport.consume(reader, {
    signal,
    onUsage: (u) => {
      usage = {
        pt: u.promptTokens ?? 0,
        ct: u.completionTokens ?? 0,
        rt: u.reasoningTokens ?? 0,
        cacheRead: u.cacheReadTokens,
        cacheCreate: u.cacheCreationTokens,
        chunkCost: u.chunkCost,
        raw: u.raw,
      };
    },
  });
  const content = turn.content;

  if (usage) {
    recordLlmUsage({
      source: "summary",
      sessionId: attrib?.sessionId,
      projectId: attrib?.projectId,
      workspaceId: attrib?.workspaceId,
      provider: llmConfig.provider,
      model,
      baseUrl,
      promptTokens: usage.pt ?? 0,
      completionTokens: usage.ct ?? 0,
      reasoningTokens: usage.rt ?? 0,
      cacheReadTokens: usage.cacheRead,
      cacheCreationTokens: usage.cacheCreate,
      costUsd: extractCost(usage.chunkCost, usage.raw),
    });
  }

  if (!content) throw new Error("Compaction returned empty summary");
  return content;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a transformContext function that performs LLM-based compaction when
 * the session's context usage crosses the threshold, falling back to the
 * simple sliding-window pruner if the LLM call fails or is not needed.
 *
 * The returned function is async-safe: concurrent calls are serialised via
 * the `compacting` flag so only one summary request is in flight at a time.
 */
export function buildCompactionTransformer(
  session: PiAgentSession,
  llmConfig: AgentLLMConfig,
  onCompactionStart?: () => void,
  onCompactionEnd?: (summary: string) => void,
): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
  const contextWindow = llmConfig.contextWindow ?? 128_000;
  let cachedSummary: string | null = null;
  let compactionPromise: Promise<string> | null = null;

  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const lastPromptTokens = session.lastPromptTokens ?? 0;
    // Always read the live signal from the session so a refreshed AbortController
    // (created on each new prompt) is used rather than the one captured at build time.
    const signal = session.abortCtrl.signal;

    // Below threshold — pass through unchanged
    if (lastPromptTokens === 0 || lastPromptTokens < contextWindow * COMPACT_THRESHOLD) {
      return messages;
    }

    // If we already have a summary from the last compaction, apply it immediately
    if (cachedSummary !== null) {
      const { toKeep } = splitMessages(messages);
      return buildCompactedContext(cachedSummary, toKeep);
    }

    // Generate summary if not already in flight
    if (!compactionPromise) {
      onCompactionStart?.();

      const { toSummarise } = splitMessages(messages);
      compactionPromise = generateSummary(toSummarise, llmConfig, signal)
        .then((summary) => {
          cachedSummary = summary;
          onCompactionEnd?.(summary);
          return summary;
        })
        .catch((err) => {
          console.warn("[compaction] summarisation failed:", err?.message ?? err);
          compactionPromise = null; // reset to allow retry
          throw err;
        });
    }

    try {
      const summary = await compactionPromise;
      const { toKeep } = splitMessages(messages);
      return buildCompactedContext(summary, toKeep);
    } catch {
      // Fallback for this turn: sliding-window trim (safe, no LLM call)
      return slidingWindowFallback(messages);
    }
  };
}

function buildCompactedContext(
  summary: string,
  recentMessages: AgentMessage[],
): AgentMessage[] {
  const summaryMessage: AgentMessage = {
    role: "user",
    content:
      "[Earlier conversation summarised to fit the context window]\n\n" +
      "## Session Summary\n\n" +
      summary +
      "\n\n[End of summary — continuing from current state]",
  };

  const result: AgentMessage[] = [];
  result.push(summaryMessage);
  result.push(...recentMessages);
  return result;
}

// ── Sliding-window fallback (no LLM) ─────────────────────────────────────────

const FALLBACK_KEEP_TURNS = 8;
const FALLBACK_THRESHOLD  = 0.80;

function slidingWindowFallback(messages: AgentMessage[]): AgentMessage[] {
  const keepIds = new Set<string>();
  let keptTurns = 0;
  let keepFromIdx = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      keptTurns++;
      if (msg.tool_calls) for (const tc of msg.tool_calls) keepIds.add(tc.id);
      keepFromIdx = i;
      if (keptTurns >= FALLBACK_KEEP_TURNS) break;
    }
  }

  const firstUser = messages.find((m) => m.role === "user");
  const tail = messages.slice(keepFromIdx);
  const extraToolResults = messages.slice(1, keepFromIdx).filter(
    (m) => m.role === "tool" && keepIds.has((m as AgentToolResultMsg).tool_call_id),
  );

  const marker: AgentMessage = {
    role: "user",
    content: "[Earlier context trimmed to fit the context window. Full history preserved in session storage.]",
  };

  const pruned: AgentMessage[] = [];
  if (firstUser) pruned.push(firstUser);
  pruned.push(marker);
  pruned.push(...extraToolResults);
  pruned.push(...tail);
  return pruned;
}

/**
 * Immediately summarise the full session history and return a compacted
 * context array. Unlike buildCompactionTransformer (which is fire-and-forget),
 * this awaits the LLM call and resolves with the final messages.
 *
 * Used by the /compact slash command to compact on demand.
 * Returns null if the session has too few messages to be worth compacting.
 */
export async function compactNow(
  session: PiAgentSession,
  llmConfig: AgentLLMConfig,
): Promise<{ messages: AgentMessage[]; summary: string } | null> {
  if (session.messages.length < 4) return null; // nothing meaningful to summarise

  const { toSummarise, toKeep } = splitMessages(session.messages);
  if (toSummarise.length === 0) return null;

  const summary = await generateSummary(toSummarise, llmConfig, session.abortCtrl.signal);
  const messages = buildCompactedContext(summary, toKeep);
  return { messages, summary };
}

// Re-export threshold for use in pi-agent-loop default pruner
export { COMPACT_THRESHOLD, FALLBACK_KEEP_TURNS, FALLBACK_THRESHOLD };
