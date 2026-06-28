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

import type { BrowserWindow } from "electron";
import type { Database } from "better-sqlite3";
import { registerIpcOn, broadcastEvent } from "./registry";
import { getCachedConfig } from "../lib/config-cache";
import { newId } from "../db/utils";
import * as q from "../db/queries";
import * as builder from "../lib/tool-builder";
import * as secrets from "../lib/secure-store";
import { buildBuilderSystemPrompt, BUILDER_TOOL_DEFS } from "../lib/tool-builder-prompt";

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
    baseUrl: (cached?.baseUrl ?? "https://api.openai.com").replace(/\/+$/, ""),
    model: cached?.model ?? "gpt-4o-mini",
    apiKey: cached?.apiKey ?? "",
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
  const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
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
        headers: args.headers as Record<string, string> | undefined,
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
  const headers = persistSecretHeaders(session, id, def.headers ?? {});
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
  const headers = persistSecretHeaders(session, id, def.headers ?? {});
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
 * Replace secret-placeholder header values with `secret://<toolId>/<header>`
 * refs. If a temp secret was captured for that header during the session, store
 * the real value now; otherwise the UI will prompt the user to fill it in.
 */
function persistSecretHeaders(
  session: BuilderSession,
  toolId: string,
  headers: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (builder.hasPlaceholder(value)) {
      const ref = secrets.secretRef(toolId, name);
      const temp = session.tempSecrets.get(name);
      if (temp && secrets.isAvailable()) {
        secrets.setSecret(toolId, name, temp);
      }
      out[name] = ref;
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
  if (!config.apiKey && config.provider !== "localllm") {
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
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* leave empty */
        }
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
  const send = (channel: string, payload: unknown) => broadcastEvent(channel, payload);

  registerIpcOn(
    "tool-builder:prompt",
    (_e, { sessionId, workspaceId, message, secret }: {
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
      if (secret?.header && secret.value) {
        session.tempSecrets.set(secret.header, secret.value);
      }
      session.messages.push({ role: "user", content: message });
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
