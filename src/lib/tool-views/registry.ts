/**
 * Micro slot-registry — the minimum of dsh's ui-slots needed to host keyed
 * `tool.call.toolview` components in Cairn's own renderer.
 *
 * dsh's real SlotCore does declaration-merge, store seats, chain slots, epochs,
 * etc. (scratch/dsh-repo/packages/client/ui-slots) — none of which a keyed
 * toolview needs. A dsh client plugin's browser half calls
 * `ctx.slots.register({ name:'tool.call.toolview', key:'<tool>' }, Component)`;
 * here we expose the same register/lookup surface so a vendored (or, later, a
 * dynamically-loaded third-party) plugin registers a React view keyed by tool
 * name, and Cairn's transcript looks it up by `toolName`.
 */
import type { ComponentType } from "react";
import type { ToolCallViewProps } from "./contract";

export type ToolViewComponent = ComponentType<ToolCallViewProps>;

const registry = new Map<string, ToolViewComponent>();

/** Register a keyed tool.call.toolview (mirrors ctx.slots.register key form). */
export function registerToolView(key: string, component: ToolViewComponent): () => void {
  registry.set(key, component);
  return () => {
    if (registry.get(key) === component) registry.delete(key);
  };
}

/** Look up the view registered for a tool name (undefined → Cairn's fallback chip). */
export function getToolView(toolName: string): ToolViewComponent | undefined {
  return registry.get(toolName);
}

/** For debugging/inspection: the set of tool names with a registered view. */
export function registeredToolViewKeys(): string[] {
  return [...registry.keys()];
}
