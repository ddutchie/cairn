/**
 * AI Tool Builder — streaming builder session (mirrors the pi-agent pattern).
 *
 * The renderer sends `tool-builder:prompt` (a fire-and-forget IPC message); the
 * main process runs a small tool-calling loop with the builder's internal tools
 * (probe / suggest_response_keys / finalize_*) dispatched LOCALLY — never via the
 * general chat executor. It emits:
 *   - `tool-builder:token`    incremental assistant text
 *   - `tool-builder:step`     a tool call started (name + sanitized args)
 *   - `tool-builder:proposal` the assembled draft config (editable in the UI)
 *   - `tool-builder:done`     terminal (with optional error)
 *
 * Safety: probes + secrets stay in main. The LLM only ever sees bodySample /
 * jsonKeys / authHint and writes secret PLACEHOLDERS. The host of the first
 * authed probe is surfaced to the renderer for confirmation. A hard cap bounds
 * probe attempts per session.
 */

import type { BrowserWindow, IpcMainEvent } from "electron";
import type { Database } from "better-sqlite3";
import { registerIpcOn } from "./registry";
import { getCachedConfig } from "../lib/config-cache";
import { isLocalEndpoint, normaliseBaseUrl, buildApiUrl } from "../lib/llm";
import { newId } from "../db/utils";
import * as q from "../db/queries";
import * as builder from "../lib/tool-builder";
import * as secrets from "../lib/secure-store";
import { buildBuilderSystemPrompt, BUILDER_TOOL_DEFS } from "../lib/tool-builder-prompt";
import { parseToolArgs } from "../lib/parse-tool-args";

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

interface BuilderSession {
  id: string;
  workspaceId: string;
  messages: OpenAIMessage[];
  abortCtrl: AbortController;
  probeCount: number;
  /** Secret values held only in main memory during the session (never persisted until finalize). */
  tempSecrets: Map<string, string>;
}

const sessions = new Map<string, BuilderSession>();

const MAX_STEPS = 16;
const MAX_PROBES = 8;

interface AIConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

function resolveConfig(): AIConfig {
  const cached = getCachedConfig().aiConfig;
  return {
    provider: cached?.provider ?? "openai",
    baseUrl: normaliseBaseUrl(cached?.baseUrl ?? "https://api.openai.com"),
    model: cached?.model ?? "gpt-5.6-luna",
    // The cached apiKey is a `secret://llm:<providerId>/apiKey` reference since the
    // v2.5.9 keychain migration — resolve it to the real key here (same as chat.ts /
    // pi-agent.ts). Sending the raw ref as a bearer token 401s the provider.
    apiKey: secrets.resolveLlmApiKey(cached?.apiKey),
  };
}

/** One non-streaming chat-completions call returning the assistant message. */
async function callModel(
  config: AIConfig,
  messages: OpenAIMessage[],
  signal: AbortSignal
): Promise<OpenAIMessage> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
  const res = await fetch(buildApiUrl(config.baseUrl, "chat/completions"), {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: config.model,
      messages,
      tools: BUILDER_TOOL_DEFS,
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 2048,
    }),
  });
  if (!res.ok) {
    throw new Error(`AI endpoint error ${res.status}: ${(await res.text().catch(() => res.statusText)).slice(0, 300)}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: OpenAIMessage }> };
  const msg = json.choices?.[0]?.message;
  if (!msg) throw new Error("No response from AI endpoint");
  return msg;
}

/** Dispatch a builder tool call locally. Returns the JSON-string tool result. */
async function dispatchBuilderTool(
  session: BuilderSession,
  db: Database,
  name: string,
  args: Record<string, unknown>,
  send: (channel: string, payload: unknown) => void
): Promise<string> {
  switch (name) {
    case "probe_endpoint": {
      if (session.probeCount >= MAX_PROBES) {
        return JSON.stringify({ error: "Probe limit reached for this session." });
      }
      session.probeCount++;
      const url = String(args.url ?? "");
      // Surface the host for renderer confirmation/visibility before an authed probe.
      const hasAuth = args.headers && Object.keys(args.headers as object).length > 0;
      if (hasAuth) {
        try {
          send("tool-builder:probe-host", { sessionId: session.id, host: new URL(url).host });
        } catch {
          /* invalid URL handled below */
        }
      }
      const result = await builder.probeEndpoint({
        url,
        method: (args.method as builder.ProbeRequest["method"]) ?? "GET",
        // Substitute the user's session secret for any placeholder header so the
        // probe is actually authenticated. The original placeholder form is what
        // the LLM authored (and what gets echoed/persisted) — only the live
        // request sees the real value, and it never leaves the main process.
        headers: resolveProbeHeaders(session, args.headers as Record<string, string> | undefined),
        query: args.query as Record<string, unknown> | undefined,
        body: args.body,
      });
      // Return only the LLM-safe subset (no raw secret echoing).
      return JSON.stringify({
        status: result.status,
        ok: result.ok,
        contentType: result.contentType,
        bodySample: result.bodySample,
        jsonKeys: result.jsonKeys,
        authHint: result.authHint,
        error: result.error,
      });
    }

    case "suggest_response_keys": {
      let sample: unknown = args.jsonSample;
      if (typeof sample === "string") {
        try {
          sample = JSON.parse(sample);
        } catch {
          /* keep as string */
        }
      }
      return JSON.stringify(builder.suggestResponseKeys(sample));
    }

    case "finalize_service": {
      const def = (args.definition ?? {}) as builder.ServiceDraft;
      const validation = builder.validateServiceDraft(def);
      if (!validation.ok) return JSON.stringify({ ok: false, errors: validation.errors });
      const saved = saveServiceDraft(session, db, def);
      send("tool-builder:proposal", { sessionId: session.id, toolType: "service", config: saved });
      return JSON.stringify({ ok: true, id: saved.id, savedDisabled: true });
    }

    case "finalize_mcp": {
      const def = (args.definition ?? {}) as builder.McpDraft;
      const validation = builder.validateMcpDraft(def);
      if (!validation.ok) return JSON.stringify({ ok: false, errors: validation.errors });
      const saved = saveMcpDraft(session, db, def);
      send("tool-builder:proposal", { sessionId: session.id, toolType: "mcp", config: saved });
      return JSON.stringify({ ok: true, id: saved.id, savedDisabled: true });
    }

    default:
      return JSON.stringify({ error: `Unknown builder tool: ${name}` });
  }
}

/**
 * Persist a service draft DISABLED. Secret-placeholder headers are converted to
 * ref tokens; any temp secret captured during the session is written to the
 * secure store keyed to the new tool id.
 */
function saveServiceDraft(session: BuilderSession, db: Database, def: builder.ServiceDraft) {
  const id = newId();
  const headers = persistSecretHeaders(session, "service", id, def.headers ?? {});
  return q.saveCustomService(db, {
    id,
    workspaceId: session.workspaceId,
    name: def.name,
    description: def.description,
    apiUrl: def.apiUrl,
    method: def.method,
    headers,
    toolDefinition: def.toolDefinition,
    responseKeys: def.responseKeys ?? [],
    apiKeyUrl: def.apiKeyUrl,
    enabled: false,
    source: "ai-builder",
  });
}

function saveMcpDraft(session: BuilderSession, db: Database, def: builder.McpDraft) {
  const id = newId();
  const headers = persistSecretHeaders(session, "mcp", id, def.headers ?? {});
  return q.saveMcpServer(db, {
    id,
    workspaceId: session.workspaceId,
    name: def.name,
    description: def.description,
    transport: def.transport ?? builder.inferTransport(def.baseUrl),
    baseUrl: def.baseUrl,
    headers,
    enabled: false,
    source: "ai-builder",
  });
}

/**
 * Resolve placeholder header values to the user's session secret for a live
 * probe. Non-placeholder values pass through. The result is used ONLY for the
 * actual request — never echoed to the renderer or sent to the LLM.
 */
function resolveProbeHeaders(
  session: BuilderSession,
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (builder.hasPlaceholder(value) && session.tempSecrets.has(name)) {
      // Substitute only the placeholder token, keeping any scheme prefix
      // (e.g. "Bearer <API_KEY>" → "Bearer <realkey>").
      out[name] = builder.replacePlaceholder(value, session.tempSecrets.get(name)!);
    } else {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Replace secret-placeholder header values with `secret://<toolId>/<header>`
 * refs. If a temp secret was captured for that header during the session, store
 * the real value now; otherwise the UI will prompt the user to fill it in.
 */
function persistSecretHeaders(
  session: BuilderSession,
  toolType: secrets.ToolKind,
  toolId: string,
  headers: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (builder.hasPlaceholder(value)) {
      const ref = secrets.secretRef(toolType, toolId, name);
      const temp = session.tempSecrets.get(name);
      if (temp && secrets.isAvailable()) {
        secrets.setSecret(toolType, toolId, name, temp);
      }
      // Swap only the placeholder token for the ref, preserving any scheme
      // prefix (e.g. "Bearer <API_KEY>" → "Bearer secret://…"). resolveSecrets
      // substitutes the embedded ref at request time.
      out[name] = builder.replacePlaceholder(value, ref);
    } else {
      out[name] = value;
    }
  }
  return out;
}

async function runBuilderLoop(
  session: BuilderSession,
  db: Database,
  send: (channel: string, payload: unknown) => void
): Promise<void> {
  const config = resolveConfig();
  if (!config.apiKey && config.provider !== "localllm" && !isLocalEndpoint(config.baseUrl)) {
    send("tool-builder:done", { sessionId: session.id, error: "No API key configured. Set one in Settings → AI & Chat." });
    return;
  }
  const { signal } = session.abortCtrl;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) {
        send("tool-builder:done", { sessionId: session.id, aborted: true });
        return;
      }
      const assistant = await callModel(config, session.messages, signal);
      session.messages.push(assistant);

      if (assistant.content) {
        send("tool-builder:token", { sessionId: session.id, delta: assistant.content });
      }

      const toolCalls = assistant.tool_calls ?? [];
      if (toolCalls.length === 0) {
        send("tool-builder:done", { sessionId: session.id });
        return;
      }

      for (const call of toolCalls) {
        const parsed = parseToolArgs(call.function.arguments);
        if (!parsed.ok) {
          // Never dispatch a builder tool with empty/guessed args — surface the
          // structured parse error to the model so it can re-issue the call.
          send("tool-builder:step", { sessionId: session.id, name: call.function.name, args: {} });
          session.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: parsed.error }) });
          continue;
        }
        const args: Record<string, unknown> = parsed.value;
        send("tool-builder:step", {
          sessionId: session.id,
          name: call.function.name,
          args: sanitizeArgsForRenderer(args),
        });
        const result = await dispatchBuilderTool(session, db, call.function.name, args, send);
        session.messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    send("tool-builder:done", { sessionId: session.id, error: "Reached the maximum number of builder steps." });
  } catch (e) {
    if (signal.aborted) {
      send("tool-builder:done", { sessionId: session.id, aborted: true });
      return;
    }
    send("tool-builder:done", { sessionId: session.id, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Strip header secret values before echoing tool-call args to the renderer. */
function sanitizeArgsForRenderer(args: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...args };
  if (clone.headers && typeof clone.headers === "object") {
    const h = clone.headers as Record<string, string>;
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      masked[k] = builder.hasPlaceholder(v) ? v : "***";
    }
    clone.headers = masked;
  }
  return clone;
}

export function registerToolBuilderHandlers(
  db: Database,
  _getWin?: () => BrowserWindow | null
): void {
  registerIpcOn(
    "tool-builder:prompt",
    (event: IpcMainEvent, { sessionId, workspaceId, message, secret }: {
      sessionId: string;
      workspaceId: string;
      message: string;
      /** Optional { header, value } the user supplied for an authed probe. */
      secret?: { header: string; value: string };
    }) => {
      let session = sessions.get(sessionId);
      if (!session) {
        session = {
          id: sessionId,
          workspaceId,
          messages: [{ role: "system", content: buildBuilderSystemPrompt() }],
          abortCtrl: new AbortController(),
          probeCount: 0,
          tempSecrets: new Map(),
        };
        sessions.set(sessionId, session);
      }
      // Each prompt starts a fresh run — never reuse an already-aborted
      // controller from a previous (cancelled) turn, which would abort every
      // subsequent run immediately.
      session.abortCtrl = new AbortController();
      if (secret?.header && secret.value) {
        const isNew = !session.tempSecrets.has(secret.header) || session.tempSecrets.get(secret.header) !== secret.value;
        session.tempSecrets.set(secret.header, secret.value);
        if (isNew) {
          // Tell the model a credential is already on hand (without ever
          // revealing it). It should probe authenticated immediately using a
          // placeholder in this header and must NOT ask the user for the key.
          // We pin the placeholder to <API_KEY> because that token is what the
          // probe/finalize secret-detection recognises (see hasPlaceholder).
          session.messages.push({
            role: "system",
            content:
              `The user has already provided a secret for the "${secret.header}" header. ` +
              `When you need to authenticate a probe, include the header ${secret.header}: <API_KEY> ` +
              `(use the literal placeholder <API_KEY> — the real value is injected out of band and you must never ask for it). ` +
              `Persist this same header with the <API_KEY> placeholder in the finalized tool.`,
          });
        }
      }
      session.messages.push({ role: "user", content: message });

      // Route this session's events ONLY back to the requesting window, so
      // probe hosts, body samples, and saved proposals never leak to other
      // renderer instances.
      const sender = event.sender;
      const send = (channel: string, payload: unknown) => {
        if (!sender.isDestroyed()) sender.send(channel, payload);
      };
      void runBuilderLoop(session, db, send);
    }
  );

  registerIpcOn("tool-builder:abort", (_e, { sessionId }: { sessionId: string }) => {
    const session = sessions.get(sessionId);
    session?.abortCtrl.abort();
  });

  registerIpcOn("tool-builder:end", (_e, { sessionId }: { sessionId: string }) => {
    sessions.delete(sessionId);
  });
}
