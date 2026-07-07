/**
 * Apple on-device Foundation Models provider (Apple Intelligence).
 *
 * Wraps our own native module (modules/apple-llm) — NOT a third-party package —
 * which streams tokens from Apple's FoundationModels framework on iOS 26+.
 * Everything runs on-device: no network, no API key, works offline.
 *
 * TUNED FOR A SMALL ON-DEVICE MODEL (per Apple's guidance):
 *   - Persistent session per chat thread: we keep ONE native LanguageModelSession
 *     (keyed by a sessionId) and reuse it, so FoundationModels holds the
 *     transcript natively instead of us re-sending flattened history each turn.
 *     Better grounding, far fewer tokens. A new chat → resetAppleSession() →
 *     fresh 4096-token window.
 *   - Short, imperative system prompt (APPLE_SYSTEM), not the long frontier-model
 *     one — the 3B model gets confused by long/indirect instructions.
 *   - Lean tool schemas: verbose descriptions are stripped before sending, since
 *     schema text counts against the 4096-token window.
 *
 * TOOL-CALLING (native): each Cairn tool's JSON Schema becomes a native
 * GenerationSchema via guided generation, so the model is *constrained* to emit
 * valid arguments (no text parsing). Apple drives the multi-tool turn inside one
 * generate(); on each tool call the native module suspends and fires onToolCall.
 * We execute the tool locally (TOOL_MAP → expo-sqlite), resolve it back into the
 * turn, and surface a `tool-executed` StreamEvent so agent.ts shows it in the
 * tool-trail WITHOUT re-running it.
 *
 * CONTEXT WINDOW: fixed 4096 tokens (instructions + transcript + tools + output).
 * Overflow surfaces as AppleLLMErrorCodes.ContextWindowExceeded.
 */

import {
  AppleLlm,
  AppleLLMError,
  AppleLLMErrorCodes,
  isAppleLlmAvailable,
  type AppleErrorEvent,
  type AppleTool,
  type AppleToolCallEvent,
} from "@modules/apple-llm";
import { TOOL_MAP } from "../tools";
import {
  type AiTool,
  type ChatProvider,
  type FilePart,
  type StreamEvent,
  type TextPart,
  type ToolPart,
  type UIMessage,
} from "./types";

/**
 * Dev-only gate. The Apple on-device provider is experimental and NOT viable for
 * Cairn's agentic tool use yet (see docs/plans/apple-foundation-models-provider.md),
 * so it's hidden from end users. It's exposed only in LOCAL builds where the
 * git-ignored `.env` sets EXPO_PUBLIC_APPLE_LLM_DEV=1 — EAS builds don't get that
 * file, so the provider never appears or resolves in shipped apps. (The native
 * module still compiles; it's dormant unless this flag turns the provider on.)
 */
export function isAppleDevEnabled(): boolean {
  const v = process.env.EXPO_PUBLIC_APPLE_LLM_DEV;
  return v === "1" || v === "true";
}

/** Whether the on-device Apple provider can run right now (dev-gated). */
export function isAppleProviderAvailable(): boolean {
  return isAppleDevEnabled() && isAppleLlmAvailable();
}

/**
 * Short, imperative system prompt for the on-device model. Deliberately terse
 * (Apple: "reduce prompts to no more than three paragraphs", "an on-device model
 * may get confused with a long and indirect instruction"). The full frontier
 * prompt in agent.ts is skipped for this provider.
 */
function appleSystemPrompt(): string {
  const iso = new Date().toISOString().slice(0, 10);
  return [
    "You are Cairn's assistant for the user's notes and tasks.",
    `Today is ${iso}; pass dates to tools as YYYY-MM-DD.`,
    "Call get_cairn_context first to get project ids, columns, and tags. Use get_project_context_pack(project_id) to summarize a project. Look up ids before writing.",
    "Answer briefly in markdown. Wrap any note title you mention in [[double brackets]].",
  ].join(" ");
}

// ── session lifecycle ────────────────────────────────────────────────────────

// One persistent native session per chat thread. Mobile has a single chat, so we
// keep one id and bump it when the user clears the chat (→ fresh context window).
let _sessionSeq = 0;
let _sessionId = `apple-session-${_sessionSeq}`;

/** Start a fresh on-device session (drops the transcript). Call when chat clears. */
export function resetAppleSession(): void {
  if (AppleLlm) AppleLlm.resetSession(_sessionId);
  _sessionSeq += 1;
  _sessionId = `apple-session-${_sessionSeq}`;
}

/** Warm the model for the current session to cut first-token latency. */
export function prewarmAppleSession(tools: Record<string, AiTool>): void {
  if (!AppleLlm || !isAppleLlmAvailable()) return;
  try {
    AppleLlm.prewarm(_sessionId, appleSystemPrompt(), buildTools(tools));
  } catch {
    // best-effort
  }
}

let _reqSeq = 0;
function nextRequestId(): string {
  _reqSeq += 1;
  return `apple-req-${Date.now().toString(36)}-${_reqSeq}`;
}

// ── message mapping ─────────────────────────────────────────────────────────

/** Readable text for one tool result part (agent.ts sets output.value to JSON). */
function toolPartText(t: ToolPart): string {
  const name = t.toolName ?? t.type.replace(/^tool-/, "");
  const args = JSON.stringify(t.input ?? {});
  const out =
    t.output && typeof t.output === "object" && "value" in t.output
      ? (t.output as { value: string }).value
      : JSON.stringify(t.output ?? "");
  return `[tool ${name}(${args}) -> ${out}]`;
}

/** Flatten one UIMessage to plain text (images noted, not sent — text model). */
function flattenMessage(m: UIMessage): string {
  const chunks: string[] = [];
  for (const p of m.parts) {
    if (p.type === "text") {
      const text = (p as TextPart).text;
      if (text) chunks.push(text);
    } else if (typeof p.type === "string" && p.type.startsWith("tool-")) {
      chunks.push(toolPartText(p as ToolPart));
    } else if (p.type === "file") {
      const f = p as FilePart;
      chunks.push(`[attachment: ${f.name ?? f.mediaType}]`);
    }
  }
  return chunks.join("\n").trim();
}

/**
 * The newest user turn to send. The persistent session already holds prior
 * turns, so we only send the latest user message (fold any trailing tool-result
 * assistant parts in, though with native tool-calling those are rare here).
 */
function latestPrompt(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const text = flattenMessage(messages[i]);
      if (text) return text;
    }
  }
  // Fallback: last non-system message.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "system") {
      const text = flattenMessage(messages[i]);
      if (text) return text;
    }
  }
  return "";
}

/**
 * Strip a JSON Schema down to what guided generation needs, dropping token-heavy
 * fields (descriptions, additionalProperties, titles) that bloat the 4096-token
 * window. Keeps structure: type, properties, required, items, enum, and numeric
 * bounds the native parser understands.
 */
function leanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(leanSchema);
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const KEEP = new Set([
    "type", "properties", "required", "items", "enum",
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
    "minItems", "maxItems", "anyOf",
  ]);
  for (const [k, v] of Object.entries(s)) {
    if (!KEEP.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = leanSchema(pv);
      }
      out[k] = props;
    } else if (k === "items" || k === "anyOf") {
      out[k] = leanSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Map the agent's tools to the native tool shape with lean, short schemas. */
function buildTools(tools: Record<string, AiTool>): AppleTool[] {
  return Object.entries(tools).map(([name, t]) => ({
    name,
    // Keep the description to one short line — it counts against the window.
    description: t.description.split(/[.\n]/)[0].slice(0, 120),
    jsonSchema: JSON.stringify(leanSchema(t.jsonSchema ?? { type: "object", properties: {} })),
  }));
}

/** Execute a tool locally and return its result as a JSON string. */
function runToolToJson(toolName: string, inputJson: string): { resultJson: string; error?: string } {
  const tool = TOOL_MAP.get(toolName);
  if (!tool) {
    return { resultJson: JSON.stringify({ error: `Unknown tool: ${toolName}` }) };
  }
  let args: Record<string, unknown> = {};
  try {
    args = inputJson ? (JSON.parse(inputJson) as Record<string, unknown>) : {};
  } catch {
    args = {};
  }
  try {
    const result = tool.run(args);
    return { resultJson: JSON.stringify(result ?? {}) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Surface as a tool result the model can react to, not a hard failure.
    return { resultJson: JSON.stringify({ error: message }) };
  }
}

// ── stream translation ──────────────────────────────────────────────────────

/**
 * Bridge the native module's event stream into an async generator of
 * StreamEvents. Text deltas stream live. Tool calls are executed locally and
 * resolved back into the native turn; each is also surfaced as
 * `tool-input-available` (+ its result) so the chat UI can show the tool-trail.
 */
async function* streamApple(
  messages: UIMessage[],
  tools: Record<string, AiTool>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  if (!AppleLlm) {
    throw new AppleLLMError(
      AppleLLMErrorCodes.ModelUnavailable,
      "On-device AI isn't available in this build.",
    );
  }

  const prompt = latestPrompt(messages);
  const nativeTools = buildTools(tools);
  const requestId = nextRequestId();
  const sessionId = _sessionId;

  type Item =
    | { kind: "token"; delta: string }
    | { kind: "toolCall"; callId: string; toolName: string; input: string }
    | { kind: "done"; finishReason: string }
    | { kind: "error"; err: AppleLLMError };
  const queue: Item[] = [];
  let notify: (() => void) | null = null;
  const push = (item: Item) => {
    queue.push(item);
    notify?.();
  };

  const subToken = AppleLlm.addListener("onToken", (e) => {
    if (e.requestId === requestId) push({ kind: "token", delta: e.delta });
  });
  const subDone = AppleLlm.addListener("onDone", (e) => {
    if (e.requestId === requestId) push({ kind: "done", finishReason: e.finishReason });
  });
  const subError = AppleLlm.addListener("onError", (e: AppleErrorEvent) => {
    if (e.requestId === requestId) push({ kind: "error", err: new AppleLLMError(e.code, e.message) });
  });
  // Tool calls are routed by sessionId (a session runs one generation at a time).
  const subTool = AppleLlm.addListener("onToolCall", (e: AppleToolCallEvent) => {
    if (e.sessionId === sessionId) {
      push({ kind: "toolCall", callId: e.callId, toolName: e.toolName, input: e.input });
    }
  });

  const onAbort = () => AppleLlm?.cancel(requestId);
  signal?.addEventListener("abort", onAbort);

  // Persistent session keeps the transcript; send only the newest user prompt.
  // Instructions are bound at session creation (first turn) via `system`.
  void AppleLlm.generate(requestId, sessionId, prompt, nativeTools, {
    system: appleSystemPrompt(),
    // Conservative reply cap to stay within the shared 4096-token window.
    maxTokens: 1024,
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    push({ kind: "error", err: new AppleLLMError(AppleLLMErrorCodes.GenerationError, message) });
  });

  try {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
      const item = queue.shift();
      if (!item) continue;

      if (item.kind === "error") throw item.err;

      if (item.kind === "token") {
        yield { type: "text-delta", delta: item.delta };
        continue;
      }

      if (item.kind === "toolCall") {
        // Execute locally, surface for the UI tool-trail (as an already-executed
        // tool so agent.ts doesn't re-run it), then resolve back into the native
        // turn. Apple continues generating once resolved.
        let input: unknown = {};
        try {
          input = item.input ? JSON.parse(item.input) : {};
        } catch {
          input = { _raw: item.input };
        }
        const { resultJson, error } = runToolToJson(item.toolName, item.input);
        let output: unknown;
        try {
          output = JSON.parse(resultJson);
        } catch {
          output = resultJson;
        }
        yield {
          type: "tool-executed",
          toolCallId: item.callId,
          toolName: item.toolName,
          input,
          output,
        };
        AppleLlm.resolveToolCall(item.callId, resultJson, error);
        continue;
      }

      // done
      yield { type: "finish", finishReason: item.finishReason || "stop" };
      return;
    }
  } finally {
    subToken.remove();
    subDone.remove();
    subError.remove();
    subTool.remove();
    signal?.removeEventListener("abort", onAbort);
  }
}

/** The on-device Apple Foundation Models provider. */
export const appleProvider: ChatProvider = {
  name: "Apple Intelligence (on-device)",
  stream: streamApple,
};
