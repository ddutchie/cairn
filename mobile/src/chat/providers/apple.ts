/**
 * Apple Foundation Models provider (Apple Intelligence) — two model kinds behind
 * one native module (modules/apple-llm), NOT a third-party package.
 *
 * 1. PRIVATE CLOUD COMPUTE (server, iOS 27+) — the USER-FACING provider.
 *    32K context + stronger reasoning, no API key, privacy-preserving. Uses the
 *    FULL Cairn tool set, the agent's full system prompt, and rich tool schemas
 *    (the on-device leanness isn't needed with 32K). Online-only; on a network
 *    failure the caller can retry another provider. Daily per-user quota (see
 *    quota handling below). This is what `appleProvider` resolves to.
 *
 * 2. ON-DEVICE (iOS 26+) — DEV-ONLY, hidden behind EXPO_PUBLIC_APPLE_LLM_DEV.
 *    The ~3B model + fixed 4096-token window proved too weak for Cairn's agentic
 *    tool use (see docs/plans/apple-foundation-models-provider.md), so it's kept
 *    only for local iteration: terse system prompt + lean schemas + small reply
 *    cap. This is `appleOnDeviceProvider`.
 *
 * TOOL-CALLING (native, both kinds): each Cairn tool's JSON Schema becomes a
 * native GenerationSchema via guided generation, so the model is *constrained*
 * to emit valid arguments (no text parsing). Apple drives the multi-tool turn
 * inside one generate(); on each tool call the native module suspends and fires
 * onToolCall. We execute the tool locally (TOOL_MAP → expo-sqlite), resolve it
 * back into the turn, and surface a `tool-executed` StreamEvent so agent.ts
 * shows it in the tool-trail WITHOUT re-running it.
 *
 * PERSISTENT SESSION per chat thread (both kinds): ONE native LanguageModelSession
 * per sessionId + model kind; reuse keeps the transcript natively (better
 * grounding, fewer tokens). A new chat → resetAppleSession() → fresh window.
 */

import {
  AppleLlm,
  AppleLLMError,
  AppleLLMErrorCodes,
  isAppleLlmAvailable,
  isAppleServerAvailable,
  type AppleErrorEvent,
  type AppleReasoningLevel,
  type AppleTool,
  type AppleToolCallEvent,
} from "@modules/apple-llm";
import { allToolMap } from "../tools";
import { getAppleReasoningLevel } from "../ai-config";
import { parseToolArgs } from "@cairn/shared/chat/parse-tool-args";
import {
  type AiTool,
  type ChatProvider,
  type FilePart,
  type StreamEvent,
  type StreamOptions,
  type TextPart,
  type ToolPart,
  type UIMessage,
} from "./types";

/**
 * Dev-only gate for the ON-DEVICE model. It's experimental and NOT viable for
 * Cairn's agentic tool use, so it's hidden from end users — exposed only in
 * LOCAL builds where the git-ignored `.env` sets EXPO_PUBLIC_APPLE_LLM_DEV=1.
 * PCC (the user-facing Apple provider) is NOT behind this flag.
 */
export function isAppleDevEnabled(): boolean {
  const v = process.env.EXPO_PUBLIC_APPLE_LLM_DEV;
  return v === "1" || v === "true";
}

/** Whether the DEV on-device Apple provider can run right now (dev-gated). */
export function isAppleOnDeviceAvailable(): boolean {
  return isAppleDevEnabled() && isAppleLlmAvailable();
}

/**
 * Whether the user-facing Apple (PCC) provider can run right now: an iOS 27+ SDK
 * build on an eligible iOS 27+ device with PCC ready. False on current EAS/
 * shipped builds (iOS 26 SDK → PCC compiled out) until an iOS 27 SDK build ships.
 */
export function isAppleServerProviderAvailable(): boolean {
  return isAppleServerAvailable();
}

/**
 * Whether ANY Apple provider is available (PCC for users, or on-device in dev).
 * Used for provider selection + settings gating.
 */
export function isAppleProviderAvailable(): boolean {
  return isAppleServerProviderAvailable() || isAppleOnDeviceAvailable();
}

/**
 * Short, imperative system prompt for the ON-DEVICE model. Deliberately terse
 * (Apple: "reduce prompts to no more than three paragraphs", "an on-device model
 * may get confused with a long and indirect instruction"). PCC uses the agent's
 * full system prompt instead (extracted from the conversation).
 */
function appleSystemPrompt(): string {
  const iso = new Date().toISOString().slice(0, 10);
  return [
    "You are Cairn's assistant for the user's notes and tasks.",
    `Today is ${iso}; pass dates to tools as YYYY-MM-DD.`,
    "Call get_cairn_context first to get project ids, columns, and tags. Use get_project_context_pack(project_id) to summarize a project. Look up ids before writing.",
    "Answer briefly in markdown. Link a note/task as [[id]] with its exact id (renders as the title); [[Title]] also works.",
  ].join(" ");
}

/** Extract the system-role text from the conversation (agent.ts injects it). */
function systemFromConversation(messages: UIMessage[]): string {
  const sys = messages.find((m) => m.role === "system");
  if (!sys) return "";
  return sys.parts
    .map((p) => (p.type === "text" ? (p as TextPart).text : ""))
    .join("\n")
    .trim();
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
  if (!AppleLlm) return;
  const server = isAppleServerProviderAvailable();
  if (!server && !isAppleLlmAvailable()) return;
  try {
    // Server (PCC) prewarm uses full schemas; on-device uses lean ones.
    AppleLlm.prewarm(_sessionId, server ? undefined : appleSystemPrompt(), buildTools(tools, server), server);
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
 * Coerce a JSON Schema into the subset Apple Foundation Models accepts. The
 * native guided-generation parser only understands the types object, array,
 * string, number, integer, boolean — it rejects the whole tool if any node has
 * `type: "null"` (or a nullable union like `["string","null"]`, the common JSON
 * Schema idiom for optional fields). Community `toolDefinition`s are author-
 * controlled, so a connector can legitimately carry these; we normalise rather
 * than reject:
 *   - `["string","null"]`  → `"string"`  (drop null from the union)
 *   - `"null"` / `["null"]`→ `"string"`  (no representable null type; fall back)
 *   - anyOf/oneOf/allOf    → recurse, dropping pure-null branches
 * Applied to BOTH the PCC and on-device paths since it's an Apple-only limit.
 */
const APPLE_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean"]);

function sanitizeAppleSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeAppleSchema);
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(s)) {
    if (k === "type") {
      // A null-only node isn't representable in Apple's type set — fall back to
      // "string" so the field still validates (rather than dropping the type and
      // risking rejection). Real types + nullable unions collapse to the type.
      out.type = normalizeType(v) ?? "string";
    } else if (k === "properties" && v && typeof v === "object") {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = sanitizeAppleSchema(pv);
      }
      out.properties = props;
    } else if (k === "items") {
      out.items = sanitizeAppleSchema(v);
    } else if ((k === "anyOf" || k === "oneOf" || k === "allOf") && Array.isArray(v)) {
      // Drop pure-null branches (the nullable idiom), then sanitise the rest.
      const branches = v
        .filter((b) => normalizeType((b as Record<string, unknown>)?.type) !== undefined)
        .map(sanitizeAppleSchema);
      if (branches.length === 1) {
        // A single surviving branch — inline it so we don't emit a 1-element union.
        Object.assign(out, branches[0]);
      } else if (branches.length > 1) {
        out[k] = branches;
      }
      // 0 branches → omit the combinator entirely.
    } else {
      out[k] = sanitizeAppleSchema(v);
    }
  }
  // A schema node that ended up with no `type` (e.g. a property whose only
  // constraint was a null-only combinator) is not representable — Apple expects
  // every node to declare a supported type, so default the leftover to "string".
  if (!("type" in out) && !("properties" in out) && !("items" in out) && !hasCombinator(out)) {
    out.type = "string";
  }
  return out;
}

function hasCombinator(o: Record<string, unknown>): boolean {
  return "anyOf" in o || "oneOf" in o || "allOf" in o;
}

/**
 * Reduce a schema node's `type` to a single Apple-supported type string, or
 * `undefined` if the node is null-only (caller decides how to handle that).
 * A bare unsupported/absent type falls back to "string".
 */
function normalizeType(type: unknown): string | undefined {
  if (Array.isArray(type)) {
    const supported = type.filter((t): t is string => typeof t === "string" && APPLE_TYPES.has(t));
    if (supported.length > 0) return supported[0];
    // Only "null" (or other unsupported) present → not representable.
    return undefined;
  }
  if (typeof type === "string") {
    return APPLE_TYPES.has(type) ? type : undefined;
  }
  return undefined;
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

/**
 * Map the agent's tools to the native tool shape. On-device uses lean, short
 * schemas (the 4096 window can't fit verbose descriptions). PCC keeps full
 * descriptions + schemas — the 32K window has room, and richer schemas improve
 * tool selection.
 */
function buildTools(tools: Record<string, AiTool>, server: boolean): AppleTool[] {
  return Object.entries(tools).map(([name, t]) => {
    // Sanitise to Apple's supported type set FIRST (both paths) so an author-
    // supplied nullable/`null` type in a community tool schema can't get the
    // whole tool rejected by the native parser.
    const rawSchema = sanitizeAppleSchema(t.jsonSchema ?? { type: "object", properties: {} });
    if (server) {
      return {
        name,
        description: t.description,
        jsonSchema: JSON.stringify(rawSchema),
      };
    }
    return {
      name,
      // Keep the description to one short line — it counts against the window.
      description: t.description.split(/[.\n]/)[0].slice(0, 120),
      jsonSchema: JSON.stringify(leanSchema(rawSchema)),
    };
  });
}

/** Execute a tool locally and return its result as a JSON string. */
async function runToolToJson(toolName: string, inputJson: string): Promise<{ resultJson: string; error?: string }> {
  // Resolve against the FULL enabled tool set (built-ins + installed services),
  // matching what buildTools advertised to the model.
  const tool = allToolMap().get(toolName);
  if (!tool) {
    return { resultJson: JSON.stringify({ error: `Unknown tool: ${toolName}` }) };
  }
  // Tolerant, LOSSLESS parse of the model's argument JSON (strict-first, then a
  // structure-only repair pass). Critically, a genuinely-unparseable payload is
  // NOT run with `{}` — that silently wrote empty notes for malformed
  // ensure_note/patch_note calls. Instead we surface a parse error the model can
  // read and re-issue the call against.
  const parsed = parseToolArgs(inputJson);
  if (!parsed.ok) {
    return {
      resultJson: JSON.stringify({ error: parsed.error }),
      error: parsed.error,
    };
  }
  const args = parsed.value;
  try {
    // Tools may be sync or async (e.g. search_notes_semantic) — await either so
    // a Promise isn't stringified as "{}" and the real output lost.
    const result = await tool.run(args);
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
 * `tool-executed` so the chat UI can show the tool-trail.
 *
 * `server` selects PCC (full prompt/schemas/32K, reasoning) vs on-device (terse
 * prompt/lean schemas/small window).
 */
function makeStreamApple(server: boolean) {
  return async function* streamApple(
    messages: UIMessage[],
    tools: Record<string, AiTool>,
    signal?: AbortSignal,
    _options?: StreamOptions,
  ): AsyncGenerator<StreamEvent> {
    if (!AppleLlm) {
      throw new AppleLLMError(
        AppleLLMErrorCodes.ModelUnavailable,
        server ? "Private Cloud Compute isn't available in this build." : "On-device AI isn't available in this build.",
      );
    }
    // If the caller already aborted before we started, short-circuit before
    // registering any listeners or kicking off a generation.
    if (signal?.aborted) {
      throw new AppleLLMError(AppleLLMErrorCodes.Cancelled, "Generation cancelled.");
    }

    const prompt = latestPrompt(messages);
    const nativeTools = buildTools(tools, server);
    const requestId = nextRequestId();
    const sessionId = _sessionId;
    // PCC: use the agent's full system prompt (from the conversation). On-device:
    // the terse prompt. Fall back to the terse one if none is present.
    const system = server ? systemFromConversation(messages) || appleSystemPrompt() : appleSystemPrompt();

    type Item =
      | { kind: "token"; delta: string }
      | { kind: "toolCall"; callId: string; toolName: string; input: string }
      | { kind: "done"; finishReason: string; promptTokens?: number; contextLimit?: number }
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
      if (e.requestId === requestId)
        push({ kind: "done", finishReason: e.finishReason, promptTokens: e.promptTokens, contextLimit: e.contextLimit });
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
    // PCC gets the 32K window + the user's chosen reasoning level; on-device a
    // small reply cap and no reasoning (the on-device model doesn't expose it).
    const reasoningLevel: AppleReasoningLevel | undefined = server ? getAppleReasoningLevel() : undefined;
    void AppleLlm.generate(requestId, sessionId, prompt, nativeTools, {
      system,
      useServer: server,
      reasoningLevel,
      maxTokens: server ? 4096 : 1024,
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
          // Parse for DISPLAY in the tool-trail (execution below re-parses via
          // runToolToJson). Use the same tolerant parser so the shown args match
          // what actually ran; fall back to a raw echo if even that fails.
          const parsedInput = parseToolArgs(item.input);
          const input: unknown = parsedInput.ok ? parsedInput.value : { _raw: item.input };
          const { resultJson, error } = await runToolToJson(item.toolName, item.input);
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
        yield {
          type: "finish",
          finishReason: item.finishReason || "stop",
          usage:
            item.promptTokens != null && item.promptTokens >= 0 && item.contextLimit != null && item.contextLimit > 0
              ? { promptTokens: item.promptTokens, contextLimit: item.contextLimit }
              : undefined,
        };
        return;
      }
    } finally {
      subToken.remove();
      subDone.remove();
      subError.remove();
      subTool.remove();
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * The USER-FACING Apple provider: Private Cloud Compute (server model, iOS 27+).
 * Full tool set, full system prompt, 32K window, reasoning. Online-only.
 */
export const appleProvider: ChatProvider = {
  name: "Apple Intelligence",
  stream: makeStreamApple(true),
};

/**
 * The DEV-ONLY on-device provider (hidden behind EXPO_PUBLIC_APPLE_LLM_DEV).
 * Terse prompt, lean schemas, small window — kept for local iteration only.
 */
export const appleOnDeviceProvider: ChatProvider = {
  name: "Apple Intelligence (on-device)",
  stream: makeStreamApple(false),
};
