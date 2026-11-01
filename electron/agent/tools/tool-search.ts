/**
 * Deferred tools: when connector/MCP tool schemas would bloat every request, only their names are offered
 * (in this tool's description) and the model loads the ones it needs with `tool_search`.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import { fail, ok } from "./schema";

/** Rough size of the external tools' schemas above which they are deferred (≈ tokens at 4 chars each). */
export const DEFER_THRESHOLD_TOKENS = 4_000;
const MAX_RESULTS = 8;
const MAX_LISTED = 120;

export const toolTokens = (tools: readonly AgentTool[]): number =>
  Math.ceil(tools.reduce((n, t) => n + t.name.length + t.description.length + JSON.stringify(t.parameters).length, 0) / 4);

function score(t: AgentTool, words: string[]): number {
  const name = t.name.toLowerCase();
  const desc = t.description.toLowerCase();
  return words.reduce((n, w) => n + (name.includes(w) ? 3 : 0) + (desc.includes(w) ? 1 : 0), 0);
}

/**
 * Activating a match adds it to `ctx.tools`, the array the running loop (this session's, or a subagent's)
 * offers from, so each agent loads into its own toolset. Names beyond the first page are reached with `page`.
 */
export function toolSearchTool(deferred: readonly AgentTool[]): AgentTool {
  const pages = Math.ceil(deferred.length / MAX_LISTED);
  const names = (page: number) => deferred.slice((page - 1) * MAX_LISTED, page * MAX_LISTED).map((t) => t.name).join(", ");
  return defineTool({
    name: "tool_search",
    description: `Load more tools. ${deferred.length} connector tools are available but not loaded yet: ${names(1)}${pages > 1 ? ", …" : ""}.\nCall this with keywords (or "select:name1,name2") and the matching tools become callable on your next step.${pages > 1 ? ` The list above is page 1 of ${pages}; pass \`page\` (2–${pages}) to list the other names instead of searching.` : ""}`,
    parameters: Type.Object({
      query: Type.String({ description: `Keywords describing what you need, or "select:<name>,<name>".${pages > 1 ? " Ignored when `page` is given." : ""}` }),
      ...(pages > 1 ? { page: Type.Optional(Type.Number({ description: `List page N (1–${pages}) of the unloaded tool names instead of searching.` })) } : {}),
    }),
    risk: () => ({ class: "READ" }),
    execute(a, ctx) {
      const page = (a as { page?: number }).page;
      if (page !== undefined) {
        const n = Math.min(pages, Math.max(1, Math.floor(page)));
        return Promise.resolve(ok(`Unloaded tools, page ${n} of ${pages}: ${names(n)}.\nLoad any with select:<name>.`));
      }
      if (!ctx.tools) return Promise.resolve(fail("This agent cannot load more tools."));
      const q = a.query.trim();
      const selected = q.toLowerCase().startsWith("select:") ? new Set(q.slice(7).split(",").map((n) => n.trim())) : undefined;
      const words = q.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 1);
      const matches = (selected
        ? deferred.filter((t) => selected.has(t.name))
        : deferred.map((t) => ({ t, s: score(t, words) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, MAX_RESULTS).map((x) => x.t));
      if (!matches.length) return Promise.resolve(ok(`No tools matched "${q}". Try other keywords, select:<name>${pages > 1 ? ", or pass page to list more names" : " from the list in this tool's description"}.`));
      const tools = ctx.tools;
      tools.push(...matches.filter((t) => !tools.some((x) => x.name === t.name)));
      return Promise.resolve(ok(`Loaded ${matches.length} tool${matches.length === 1 ? "" : "s"} — call them now:\n${matches.map((t) => `- ${t.name}: ${t.description.split("\n")[0].slice(0, 160)}`).join("\n")}`));
    },
  });
}
