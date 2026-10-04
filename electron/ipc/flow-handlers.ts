/**
 * Cairn — IPC handlers for Idea Flow (channels `db:flow:*`).
 *
 * The `db:flow:*` channel set used to be inlined in the 1054-line god-file
 * `ipc/handlers.ts` (P2 of the cleanup plan). The brief node/edge CRUD handlers
 * delegate to `q.*` from `db/queries.ts`. The `db:flow:node:summarize` handler
 * includes an inlined BFS that collects content from every node reachable from
 * the summary node (both edge directions), skips other `ai_summary` nodes,
 * and feeds the collected text into `callLLM`.
 *
 * NOTE (tracked): the BFS here is partly duplicated by `q.getResolvedFlow`
 * (`db/queries.ts:651-735`). A deeper refactor could extract a shared
 * `walkReachableNodes(db, nodeId)` helper into `db/queries.ts`. Out of scope
 * for P2 (no-behaviour-change refactor) — file as follow-up if flow
 * traversal diverges.
 */

import { registerContractHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as q from "../db/queries";
import { isLocalEndpoint, normaliseBaseUrl } from "../lib/llm";
import { getCachedConfig, cacheLlmConnection } from "../lib/config-cache";
import { resolveLlmApiKey } from "../lib/secure-store";

/**
 * Resolve the effective AI config (cache fallback + normalisation).
 *
 * Shared logic between `db:flow:node:summarize` and `ai:generatePrd` — kept
 * local until a third callsite justifies promoting it to `lib/`.
 */
function resolveAiConfig(input: { baseUrl?: string; model?: string; apiKey?: string }): {
  baseUrl: string;
  model: string;
  apiKey: string;
  apiMode?: "responses" | "completions" | "anthropic-messages";
} | { error: string } {
  let reqConfig: { baseUrl?: string; model?: string; apiKey?: string } = input;
  if (!reqConfig?.apiKey) {
    const cached = getCachedConfig().aiConfig;
    if (cached?.apiKey) {
      reqConfig = {
        ...reqConfig,
        baseUrl: reqConfig?.baseUrl || cached.baseUrl,
        model: reqConfig?.model || cached.model,
        apiKey: cached.apiKey,
      };
    }
  }

  const baseUrl = normaliseBaseUrl(reqConfig?.baseUrl || "https://api.openai.com");
  const model = reqConfig?.model || "gpt-5.6-luna";
  const keyRef = reqConfig?.apiKey || "";
  const isLocal = isLocalEndpoint(baseUrl);
  if (!keyRef && !isLocal) {
    return { error: "AI is not configured. Add an API key in Settings → AI & Chat, or use a local endpoint." };
  }
  // Pin the protocol from the active saved provider (see ai-handlers.resolveConfig).
  const ai = getCachedConfig().aiConfig;
  const apiMode = ai?.savedProviders?.find((p) => p.id === ai?.activeProviderId)?.apiMode as ("responses" | "completions" | "anthropic-messages" | undefined);
  // `keyRef` is a keychain reference token; resolve to the real key for this request only.
  return { baseUrl, model, apiKey: resolveLlmApiKey(keyRef), apiMode };
}

export function registerFlowHandlers(ctx: DbContext): void {
  // ── Read ──────────────────────────────────────────
  registerContractHandle("db:flow:get", (_e, { projectId }) => handle(() => q.getResolvedFlow(ctx.db, projectId)));

  // ── Node CRUD ─────────────────────────────────────
  registerContractHandle("db:flow:node:create", (_e, { projectId, ...node }) =>
    handle(() => {
      const flow = q.getOrCreateFlow(ctx.db, projectId);
      return q.createFlowNode(ctx.db, { ...node, flowId: flow.id, id: q.generateId() });
    })
  );

  registerContractHandle("db:flow:node:update", (_e, { id, patch }) =>
    handle(() => q.updateFlowNode(ctx.db, id, patch))
  );

  registerContractHandle("db:flow:node:delete", (_e, { id }) => handle(() => q.deleteFlowNode(ctx.db, id)));

  // ── Edge CRUD ─────────────────────────────────────
  registerContractHandle("db:flow:edge:create", (_e, { projectId, ...edge }) =>
    handle(() => {
      const flow = q.getOrCreateFlow(ctx.db, projectId);
      return q.createFlowEdge(ctx.db, { ...edge, flowId: flow.id, id: q.generateId() });
    })
  );

  registerContractHandle("db:flow:edge:delete", (_e, { id }) => handle(() => q.deleteFlowEdge(ctx.db, id)));

  // ── AI summary for an ai_summary node ─────────────
  // Recursively walks the entire connected subgraph (BFS in both edge directions),
  // collecting all ancestor/peer content nodes transitively — not just direct neighbours.
  // Other ai_summary nodes in the graph are skipped to avoid circular self-reference.
  registerContractHandle(
    "db:flow:node:summarize",
    (_e, args) =>
      handle(async () => {
        // Cache the connection (apiKey scrubbed to a ref-or-clear by the cache layer).
        cacheLlmConnection("ai", args.config);

        const resolved = resolveAiConfig(args.config);
        if ("error" in resolved) throw new Error(resolved.error);
        const { baseUrl, model, apiKey, apiMode } = resolved;

        const { parts, projectId: flowProjectId, workspaceId: flowWorkspaceId } =
          q.collectFlowSummaryInputs(ctx.db, args.nodeId);

        const userPrompt = `Summarise the following connected items into a concise paragraph (3–5 sentences). Focus on themes, relationships, and key points. Reply with plain prose only — no bullet points, no headers, no XML, no tool calls, no markdown formatting of any kind.\n\n${parts.join("\n\n")}`;
        const systemPrompt = "You are a concise synthesis assistant. Your only job is to write a short prose paragraph summarising the provided content. Output plain text only — no XML, no tool calls, no function invocations, no markdown, no bullet points, no headings. Just the summary text.";

        let summary: string;
        try {
          const { runOneShot } = await import("../cordis/one-shot");
          summary = await runOneShot({
            systemPrompt, userPrompt,
            config: { baseUrl, model, apiKey, provider: "openai", apiMode },
            source: "flow-ai-summary",
            sessionId: args.nodeId,
            projectId: flowProjectId,
            workspaceId: flowWorkspaceId,
          });
        } catch (e) {
          throw new Error(`AI call failed: ${(e as Error).message}`);
        }

        // Write summary back into the node's data
        q.updateFlowNode(ctx.db, args.nodeId, { data: { content: summary.trim() } });
        return { nodeId: args.nodeId, content: summary.trim() };
      })
  );
}
