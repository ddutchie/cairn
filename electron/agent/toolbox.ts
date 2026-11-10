/**
 * Staged tool loading: a session starts with a base toolset and adds whole groups when the model
 * asks for them, instead of every surface carrying a fixed list.
 *
 * The shape is dictated by prompt caching. Providers cache a request by its prefix and the tool
 * list sits at the front of it, so every change to the list re-writes the cache for the whole
 * conversation. A toolbox therefore only ever grows, and in a fixed order:
 *
 *   base tools → `enable_tools` → groups in the order they were enabled → tail (connector tools)
 *
 * Enabling a group costs one re-write; nothing is ever unloaded, and `enable_tools` describes
 * every group whether or not it is on, so its own definition never changes. The order groups were
 * enabled in is logged (`tools/enabled`), so a session reopened later sends the same list.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "./tools";

export interface ToolGroup {
  id: string;
  /** One line for the model: what the group is for. */
  summary: string;
  tools: readonly AgentTool[];
}

/** A tool list that can change between the steps of a turn. The loop reads it once per step. */
export interface ToolSource {
  current(): readonly AgentTool[];
  /**
   * The model called a tool that is not loaded. If it belongs to a group that can be turned on,
   * turn it on and return the group's id; the loop then asks the model to call again.
   */
  enableFor?(toolName: string, sessionId: string): Promise<string | undefined>;
}

export type ToolsInput = readonly AgentTool[] | ToolSource;

export const resolveTools = (tools: ToolsInput): readonly AgentTool[] => ("current" in tools ? tools.current() : tools);

export const ENABLE_TOOLS = "enable_tools";

export interface ToolboxOptions {
  base: readonly AgentTool[];
  /** Groups the model can turn on. Empty groups are dropped. */
  groups: readonly ToolGroup[];
  /** Group ids already on, in the order they were enabled (from the session log). */
  enabled?: readonly string[];
  /** Always last: tools whose presence can vary between turns (connectors). */
  tail?: readonly AgentTool[];
  /** A group was turned on for the first time. */
  onEnable?: (group: string, sessionId: string) => void | Promise<void>;
}

export class Toolbox implements ToolSource {
  private readonly groups: Map<string, ToolGroup>;
  private readonly enabled: string[] = [];
  private readonly enableTool: AgentTool | undefined;

  constructor(private readonly opts: ToolboxOptions) {
    this.groups = new Map(opts.groups.filter((g) => g.tools.length > 0).map((g) => [g.id, g]));
    for (const id of opts.enabled ?? []) if (this.groups.has(id) && !this.enabled.includes(id)) this.enabled.push(id);
    this.enableTool = this.groups.size ? this.buildEnableTool() : undefined;
  }

  enabledGroups(): readonly string[] { return this.enabled; }

  current(): readonly AgentTool[] {
    const out: AgentTool[] = [...this.opts.base];
    if (this.enableTool) out.push(this.enableTool);
    for (const id of this.enabled) out.push(...this.groups.get(id)!.tools);
    out.push(...(this.opts.tail ?? []));
    // First definition wins, so a group or connector can't replace a tool the model already has.
    const seen = new Set<string>();
    return out.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
  }

  /** Turn a group on. False when it was already on. */
  private async enable(group: string, sessionId: string): Promise<boolean> {
    if (this.enabled.includes(group)) return false;
    this.enabled.push(group);
    await this.opts.onEnable?.(group, sessionId);
    return true;
  }

  /** Models that skip `enable_tools` and call a tool by name still get it, one step later. */
  async enableFor(toolName: string, sessionId: string): Promise<string | undefined> {
    for (const g of this.groups.values()) {
      if (!g.tools.some((t) => t.name === toolName)) continue;
      await this.enable(g.id, sessionId);
      return g.id;
    }
    return undefined;
  }

  private buildEnableTool(): AgentTool {
    const catalog = [...this.groups.values()].map((g) => `- ${g.id}: ${g.summary} (${g.tools.map((t) => t.name).join(", ")})`).join("\n");
    return defineTool({
      name: ENABLE_TOOLS,
      description: `Turn on a group of tools that is not loaded yet. The tools are available from your next step and stay on for the rest of the session. Enable a group only when the task needs it.\n\nGroups:\n${catalog}`,
      parameters: Type.Object({ group: Type.String({ description: "Group id from the list." }) }),
      // Changes what the model can ask for, not anything outside the conversation; each tool still goes through its own approval.
      risk: () => ({ class: "READ" }),
      execute: async ({ group }, ctx) => {
        const g = this.groups.get(group);
        if (!g) return { content: `Unknown tool group "${group}". Available: ${[...this.groups.keys()].join(", ")}.`, isError: true };
        const names = g.tools.map((t) => t.name).join(", ");
        if (!(await this.enable(group, ctx.sessionId))) return { content: `The ${group} tools are already on: ${names}.` };
        return { content: `Enabled the ${group} tools: ${names}. Call them from your next step.` };
      },
    });
  }
}
