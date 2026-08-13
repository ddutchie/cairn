/**
 * Cairn — OpenAI Responses API shared helpers (desktop + mobile).
 *
 * Pure, framework-free: no I/O and no Electron / React Native imports — the
 * fetch + streaming layers live with each caller:
 *   - Electron: `electron/lib/responses.ts` re-exports these and adds the
 *     desktop `StreamedTurn` SSE parser (`consumeResponsesStream`).
 *   - Mobile: `mobile/src/chat/providers/responses.ts` builds the request with
 *     these and parses the SSE into the mobile `StreamEvent` stream.
 *
 * The Responses API (`POST /v1/responses`) is OpenAI-native and, via the Open
 * Responses spec, the wire format the ecosystem is standardising on. These
 * helpers convert the Chat Completions shapes both apps already produce
 * (messages with `tool_calls`, multimodal `text`/`image_url`/`document` content
 * parts, `{ type:"function", function:{…} }` tools) into the Responses shapes.
 */

// ── Endpoint gating ──────────────────────────────────────────────────────────

/**
 * True when the base URL is OpenAI's native endpoint (or Azure OpenAI's
 * preview) and can therefore serve `/v1/responses`. Anything else (OpenRouter,
 * local servers, gateways) must be probed at runtime rather than assumed.
 */
export function isResponsesEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === "api.openai.com" ||
      host.endsWith(".openai.azure.com") ||
      host.endsWith(".api.azure.com")
    );
  } catch {
    const lower = baseUrl.toLowerCase();
    return lower.includes("api.openai.com") || lower.includes("openai.azure.com");
  }
}

/** HTTP statuses that mean "this route does not exist on this provider". */
export function isEndpointNotFound(status: number): boolean {
  return status === 404 || status === 405;
}

// ── Types ────────────────────────────────────────────────────────────────────

/** A single Responses input item (message / function_call / function_call_output / …). */
export type ResponsesInputItem = Record<string, unknown>;

/**
 * A source message in the Chat Completions shape both apps produce. `content`
 * is a string, a multimodal parts array, or null; `tool_calls` are the standard
 * `{ id, function: { name, arguments } }` records.
 */
export interface ResponsesSourceMessage {
  role: string;
  content: string | unknown[] | null;
  tool_calls?: Array<{ id: string; type?: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** A flattened Responses `function` tool (the Chat Completions `function` wrapper is dropped). */
export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
}

// ── Conversion ───────────────────────────────────────────────────────────────

/**
 * Flatten a Chat Completions tool definition to the Responses shape: the
 * external `{ type: "function", function: { name, description, parameters } }`
 * wrapper becomes an internally-tagged `{ type: "function", name, ... }`.
 */
export function mapToolToResponses(tool: unknown): ResponsesFunctionTool {
  const t = (tool ?? {}) as Record<string, unknown>;
  const func = (t.function ?? t) as Record<string, unknown>;
  const out: ResponsesFunctionTool = {
    type: "function",
    name: String(func.name ?? t.name ?? ""),
  };
  if (func.description != null) out.description = String(func.description);
  if (func.parameters != null) out.parameters = func.parameters;
  return out;
}

/**
 * Convert a Chat Completions multimodal `content` array into the Responses
 * input-part shapes: `text` → `input_text`, `image_url` → `input_image`,
 * `document` (PDF) → `input_file`. Unknown parts pass through unchanged so
 * provider-specific parts are never silently dropped.
 */
export function mapContentPartsToResponses(parts: unknown[]): unknown[] {
  return parts.map((p) => {
    const part = (p ?? {}) as Record<string, unknown>;
    switch (part.type) {
      case "text":
        return { type: "input_text", text: String(part.text ?? "") };
      case "image_url": {
        const iu = (part.image_url ?? {}) as Record<string, unknown>;
        return { type: "input_image", image_url: String(iu.url ?? "") };
      }
      case "document": {
        // Chat Completions carries PDFs as `{ type:"document", source:{ type:"base64",
        // media_type, data } }`. Responses takes a data URL in `file_data`.
        const src = (part.source ?? {}) as Record<string, unknown>;
        const mediaType = String(src.media_type ?? "application/pdf");
        const data = String(src.data ?? "");
        return {
          type: "input_file",
          filename: "document.pdf",
          file_data: `data:${mediaType};base64,${data}`,
        };
      }
      default:
        return part;
    }
  });
}

/**
 * Convert a multi-turn message history into Responses input items.
 *
 * Mapping (from the migration guide's "Map Messages to Items"):
 *   - system/developer message  → top-level `instructions` (concatenated)
 *   - user message              → `{ role: "user", content }`
 *   - assistant message         → `{ role: "assistant", content }` (when it has
 *                                 text) plus one `function_call` item per
 *                                 `tool_calls[]` entry
 *   - tool result               → `{ type: "function_call_output", call_id,
 *                                 output }`
 *
 * `call_id` linkage between a `function_call` item and its
 * `function_call_output` item is preserved verbatim — the same contract the
 * chat-completions loop relies on.
 */
export function mapMessagesToInput(messages: ResponsesSourceMessage[]): {
  instructions?: string;
  input: ResponsesInputItem[];
} {
  let instructions: string | undefined;
  const input: ResponsesInputItem[] = [];

  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text) instructions = instructions ? `${instructions}\n\n${text}` : text;
      continue;
    }
    if (m.role === "assistant") {
      if (typeof m.content === "string" && m.content.trim()) {
        input.push({ type: "message", role: "assistant", content: m.content });
      }
      for (const tc of m.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
      continue;
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: m.content ?? "",
      });
      continue;
    }
    // user (and any future role) — convert multimodal content parts, else pass
    // the string content through verbatim.
    input.push({
      type: "message",
      role: "user",
      content: Array.isArray(m.content) ? mapContentPartsToResponses(m.content) : (m.content ?? ""),
    });
  }

  return { instructions, input };
}

// ── Request body ─────────────────────────────────────────────────────────────

/**
 * Build a Responses request body from the same inputs a Chat Completions caller
 * would pass. Differences from Chat Completions:
 *
 *   - `messages` → `input` (+ `instructions` for system guidance)
 *   - `tools` are flattened (no `function` wrapper)
 *   - `max_tokens` → `max_output_tokens`
 *   - `reasoning_effort` → `reasoning.effort` (Responses nests it)
 *   - optional `reasoning.summary` request (condensed thinking)
 *   - no `stream_options` — usage always arrives on `response.completed`
 *   - no `tool_choice` — Responses defaults to auto tool use
 */
export function buildResponsesBody(opts: {
  model: string;
  messages: ResponsesSourceMessage[];
  tools?: unknown[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: "none" | "low" | "high" | "max";
  /** Request a condensed reasoning summary (Responses-only, OpenAI-hosted models). */
  reasoningSummary?: "concise" | "detailed";
  /** Stream (SSE). Default true; one-shots pass false and read the JSON body. */
  stream?: boolean;
  /** Tool-call policy ("none" / "required" / "auto"). Omit = auto. */
  toolChoice?: "none" | "auto" | "required";
}): Record<string, unknown> {
  const { instructions, input } = mapMessagesToInput(opts.messages);
  const reasoning = {
    ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
    ...(opts.reasoningSummary ? { summary: opts.reasoningSummary } : {}),
  };
  return {
    model: opts.model,
    ...(instructions ? { instructions } : {}),
    input,
    tools: (opts.tools ?? []).map(mapToolToResponses),
    ...(opts.maxTokens && opts.maxTokens > 0 ? { max_output_tokens: opts.maxTokens } : {}),
    temperature: opts.temperature,
    stream: opts.stream ?? true,
    ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
    ...(opts.reasoningEffort || opts.reasoningSummary ? { reasoning } : {}),
  };
}

// ── Non-streaming output conversion ───────────────────────────────────────────

export interface ParsedResponsesUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  raw: unknown;
}

/**
 * Parse a NON-streaming Responses JSON body into the text content, any
 * reasoning summary, and usage — the analogue of reading
 * `choices[0].message.content` on Chat Completions.
 */
export function parseResponsesOutput(json: unknown): {
  content: string;
  reasoningSummary: string;
  usage?: ParsedResponsesUsage;
} {
  const resp = (json ?? {}) as Record<string, unknown>;
  let content = "";
  let reasoningSummary = "";
  const output = resp.output as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (item.type === "message") {
        const parts = item.content as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part.type === "output_text" && typeof part.text === "string") content += part.text;
          }
        }
      } else if (item.type === "reasoning") {
        const summary = item.summary as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(summary)) {
          reasoningSummary = summary
            .map((p) => String(p.text ?? ""))
            .filter(Boolean)
            .join("\n");
        }
      }
    }
  }
  const usage = resp.usage as Record<string, unknown> | undefined;
  let parsedUsage: ParsedResponsesUsage | undefined;
  if (usage) {
    const outDetails = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
    const inDetails = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
    parsedUsage = {
      promptTokens: Number(usage.input_tokens ?? 0),
      completionTokens: Number(usage.output_tokens ?? 0),
      reasoningTokens: Number(outDetails.reasoning_tokens ?? 0),
      cacheReadTokens: Number(inDetails.cached_tokens ?? 0),
      raw: usage,
    };
  }
  return { content, reasoningSummary, usage: parsedUsage };
}

/**
 * Normalise a non-streaming Responses body into the Chat Completions shape
 * (`choices[0].message` + OpenAI-style `usage`) so existing non-streaming
 * consumers can keep their parsing unchanged.
 */
export function responsesToCompletionsShape(json: unknown): Record<string, unknown> {
  const resp = (json ?? {}) as Record<string, unknown>;
  const output = (resp.output as Array<Record<string, unknown>> | undefined) ?? [];
  let content = "";
  const tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  for (const item of output) {
    if (item.type === "message") {
      for (const part of (item.content as Array<Record<string, unknown>> | undefined) ?? []) {
        if (part.type === "output_text" && typeof part.text === "string") content += part.text;
      }
    } else if (item.type === "function_call") {
      tool_calls.push({
        id: String(item.call_id ?? ""),
        type: "function",
        function: { name: String(item.name ?? ""), arguments: String(item.arguments ?? "") },
      });
    }
  }
  const usage = resp.usage as Record<string, unknown> | undefined;
  const outDetails = (usage?.output_tokens_details ?? {}) as Record<string, unknown>;
  const inDetails = (usage?.input_tokens_details ?? {}) as Record<string, unknown>;
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          ...(tool_calls.length ? { tool_calls } : {}),
        },
      },
    ],
    usage: {
      prompt_tokens: Number(usage?.input_tokens ?? 0),
      completion_tokens: Number(usage?.output_tokens ?? 0),
      completion_tokens_details: { reasoning_tokens: Number(outDetails.reasoning_tokens ?? 0) },
      // Responses reports cached tokens under input_tokens_details; surface it
      // as prompt_tokens_details.cached_tokens so extractCacheTokens reads it.
      prompt_tokens_details: { cached_tokens: Number(inDetails.cached_tokens ?? 0) },
    },
  };
}
