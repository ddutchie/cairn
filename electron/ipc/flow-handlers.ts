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
 * **TODO**: the BFS here is partly duplicated by `q.getResolvedFlow`
 * (`db/queries.ts:651-735`). A deeper refactor could extract a shared
 * `walkReachableNodes(db, nodeId)` helper into `db/queries.ts`. Out of scope
 * for P2 (which is a no-behaviour-change refactor).
 */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as q from "../db/queries";
import { isLocalEndpoint, callLLM, normaliseBaseUrl } from "../lib/llm";
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
  const model = reqConfig?.model || "gpt-4o-mini";
  const keyRef = reqConfig?.apiKey || "";
  const isLocal = isLocalEndpoint(baseUrl);
  if (!keyRef && !isLocal) {
    return { error: "AI is not configured. Add an API key in Settings → AI & Chat, or use a local endpoint." };
  }
  // `keyRef` is a keychain reference token; resolve to the real key for this request only.
  return { baseUrl, model, apiKey: resolveLlmApiKey(keyRef) };
}

export function registerFlowHandlers(ctx: DbContext): void {
  // ── Read ──────────────────────────────────────────
  registerIpcHandle("db:flow:get", (_e, { projectId }) => handle(() => q.getResolvedFlow(ctx.db, projectId)));

  // ── Node CRUD ─────────────────────────────────────
  registerIpcHandle(
    "db:flow:node:create",
    (_e, args: { projectId: string } & Partial<Parameters<typeof q.createFlowNode>[1]>) =>
      handle(() => {
        const flow = q.getOrCreateFlow(ctx.db, args.projectId);
        return q.createFlowNode(ctx.db, {
          ...args,
          flowId: flow.id,
          id: q.generateId(),
        } as Parameters<typeof q.createFlowNode>[1]);
      })
  );

  registerIpcHandle("db:flow:node:update", (_e, { id, patch }) =>
    handle(() => q.updateFlowNode(ctx.db, id, patch))
  );

  registerIpcHandle("db:flow:node:delete", (_e, { id }) => handle(() => q.deleteFlowNode(ctx.db, id)));

  // ── Edge CRUD ─────────────────────────────────────
  registerIpcHandle(
    "db:flow:edge:create",
    (_e, args: { projectId: string } & Partial<Parameters<typeof q.createFlowEdge>[1]>) =>
      handle(() => {
        const flow = q.getOrCreateFlow(ctx.db, args.projectId);
        return q.createFlowEdge(ctx.db, {
          ...args,
          flowId: flow.id,
          id: q.generateId(),
        } as Parameters<typeof q.createFlowEdge>[1]);
      })
  );

  registerIpcHandle("db:flow:edge:delete", (_e, { id }) => handle(() => q.deleteFlowEdge(ctx.db, id)));

  // ── AI summary for an ai_summary node ─────────────
  // Recursively walks the entire connected subgraph (BFS in both edge directions),
  // collecting all ancestor/peer content nodes transitively — not just direct neighbours.
  // Other ai_summary nodes in the graph are skipped to avoid circular self-reference.
  registerIpcHandle(
    "db:flow:node:summarize",
    (_e, args: { nodeId: string; config: { baseUrl: string; model: string; apiKey: string } }) =>
      handle(async () => {
        // Cache the connection (apiKey scrubbed to a ref-or-clear by the cache layer).
        cacheLlmConnection("ai", args.config);

        const resolved = resolveAiConfig(args.config);
        if ("error" in resolved) throw new Error(resolved.error);
        const { baseUrl, model, apiKey } = resolved;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type DbRow = Record<string, any>;

        const nodeRow = ctx.db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(args.nodeId) as DbRow | undefined;
        if (!nodeRow) throw new Error("Node not found");
        if (nodeRow.type !== "ai_summary") throw new Error("Summarize is only available on ai_summary nodes");

        const flowId = nodeRow.flow_id as string;

        // Load all edges for this flow once
        const allEdges = ctx.db.prepare("SELECT * FROM idea_flow_edges WHERE flow_id = ?").all(flowId) as DbRow[];

        // BFS: traverse all nodes reachable from the summary node (both edge directions),
        // excluding the summary node itself and other ai_summary nodes.
        const visited = new Set<string>([args.nodeId]);
        const queue: string[] = [];

        // Seed queue with direct neighbours
        for (const e of allEdges) {
          if (e.source_node_id === args.nodeId && !visited.has(e.target_node_id)) {
            queue.push(e.target_node_id as string);
            visited.add(e.target_node_id as string);
          }
          if (e.target_node_id === args.nodeId && !visited.has(e.source_node_id)) {
            queue.push(e.source_node_id as string);
            visited.add(e.source_node_id as string);
          }
        }

        // BFS expansion
        while (queue.length > 0) {
          const current = queue.shift()!;
          const currentRow = ctx.db.prepare("SELECT type FROM idea_flow_nodes WHERE id = ?").get(current) as DbRow | undefined;
          // Don't recurse through other ai_summary nodes — they're peers, not content
          if (currentRow?.type === "ai_summary") continue;

          for (const e of allEdges) {
            if (e.source_node_id === current && !visited.has(e.target_node_id)) {
              queue.push(e.target_node_id as string);
              visited.add(e.target_node_id as string);
            }
            if (e.target_node_id === current && !visited.has(e.source_node_id)) {
              queue.push(e.source_node_id as string);
              visited.add(e.source_node_id as string);
            }
          }
        }

        // Remove the summary node itself from the set
        visited.delete(args.nodeId);

        if (visited.size === 0) {
          throw new Error("Connect this node to other nodes first — nothing to summarise yet.");
        }

        // Build a text description of each collected node
        const parts: string[] = [];
        for (const nid of visited) {
          const nrow = ctx.db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(nid) as DbRow | undefined;
          if (!nrow) continue;
          let data: Record<string, unknown> = {};
          try { data = JSON.parse(nrow.data); } catch { /* empty */ }

          const type = nrow.type as string;
          if (type === "idea") {
            const title = data.title as string | undefined;
            const body = data.body as string | undefined;
            parts.push(`[Idea] ${title ?? "Untitled"}${body ? `: ${body}` : ""}`);
          } else if (type === "note_ref" && data.noteId) {
            const noteRow = ctx.db.prepare("SELECT title, content_text FROM notes WHERE id = ?").get(data.noteId) as
              | { title: string; content_text: string }
              | undefined;
            if (noteRow) parts.push(`[Note] ${noteRow.title}: ${noteRow.content_text?.slice(0, 600) ?? ""}`);
          } else if (type === "task_ref" && data.cardId) {
            const cardRow = ctx.db.prepare(
              "SELECT tc.title, tc.description, tc.priority, bc.name as col FROM task_cards tc LEFT JOIN board_columns bc ON tc.column_id = bc.id WHERE tc.id = ?"
            ).get(data.cardId) as { title: string; description: string; priority: string; col: string } | undefined;
            if (cardRow) parts.push(`[Task] ${cardRow.title} (${cardRow.priority}, ${cardRow.col})${cardRow.description ? `: ${cardRow.description}` : ""}`);
          } else if (type === "url") {
            const title = data.title as string | undefined;
            const url = data.url as string | undefined;
            const desc = data.description as string | undefined;
            parts.push(`[URL] ${title ?? url ?? "Link"}${desc ? `: ${desc}` : ""}`);
          }
          // ai_summary nodes are excluded from content collection (skipped in BFS above)
        }

        if (parts.length === 0) {
          throw new Error("No content found in the connected nodes — add text to the idea, note, or task nodes first.");
        }

        const userPrompt = `Summarise the following connected items into a concise paragraph (3–5 sentences). Focus on themes, relationships, and key points. Reply with plain prose only — no bullet points, no headers, no XML, no tool calls, no markdown formatting of any kind.\n\n${parts.join("\n\n")}`;
        const systemPrompt = "You are a concise synthesis assistant. Your only job is to write a short prose paragraph summarising the provided content. Output plain text only — no XML, no tool calls, no function invocations, no markdown, no bullet points, no headings. Just the summary text.";

        let summary: string;
        try {
          summary = await callLLM({ baseUrl, model, apiKey }, systemPrompt, userPrompt);
        } catch (e) {
          throw new Error(`AI call failed: ${(e as Error).message}`);
        }

        // Write summary back into the node's data
        q.updateFlowNode(ctx.db, args.nodeId, { data: { content: summary.trim() } });
        return { nodeId: args.nodeId, content: summary.trim() };
      })
  );
}
