/**
 * Deferred tools: when connector/MCP tool schemas would bloat every request, only their names are offered
 * (in this tool's description) and the model loads the ones it needs with `tool_search`.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import { ok } from "./schema";

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

/** `live` is the array the loop offers tools from; activating a match pushes it there. */
export function toolSearchTool(deferred: readonly AgentTool[], live: () => AgentTool[]): AgentTool {
  const listed = deferred.slice(0, MAX_LISTED).map((t) => t.name).join(", ");
  return defineTool({
    name: "tool_search",
    description: `Load more tools. ${deferred.length} connector tools are available but not loaded yet: ${listed}${deferred.length > MAX_LISTED ? ", …" : ""}.\nCall this with keywords (or "select:name1,name2") and the matching tools become callable on your next step.`,
    parameters: Type.Object({ query: Type.String({ description: 'Keywords describing what you need, or "select:<name>,<name>".' }) }),
    risk: () => ({ class: "READ" }),
    execute(a) {
      const q = a.query.trim();
      const names = q.toLowerCase().startsWith("select:") ? new Set(q.slice(7).split(",").map((n) => n.trim())) : undefined;
      const words = q.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 1);
      const matches = (names
        ? deferred.filter((t) => names.has(t.name))
        : deferred.map((t) => ({ t, s: score(t, words) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, MAX_RESULTS).map((x) => x.t));
      if (!matches.length) return Promise.resolve(ok(`No tools matched "${q}". Try other keywords or select:<name> from the list in this tool's description.`));
      const tools = live();
      const fresh = matches.filter((t) => !tools.some((x) => x.name === t.name));
      tools.push(...fresh);
      return Promise.resolve(ok(`Loaded ${matches.length} tool${matches.length === 1 ? "" : "s"} — call them now:\n${matches.map((t) => `- ${t.name}: ${t.description.split("\n")[0].slice(0, 160)}`).join("\n")}`));
    },
  });
}
