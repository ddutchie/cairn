/**
 * §11 toolview micro-host — public entry.
 *
 * `<DshToolView tc={...} />` renders a Cairn ChatToolCall through a registered
 * dsh `tool.call.toolview` component (looked up by tool name), wrapped in the
 * `.dsh-toolview-scope` div that provides the `--dsw-*` theme shim. Returns null
 * when no dsh view is registered for the tool — the caller falls back to Cairn's
 * own chip.
 *
 * `registerBuiltinToolViews()` plays the role of a dsh client plugin's browser
 * half: it registers the vendored views. Later, third-party plugin `./client`
 * halves would call registerToolView(key, Component) the same way.
 */
import React from "react";
import type { ChatToolCall } from "@/hooks/useChatStream";
import { getToolView, registerToolView, registeredToolViewKeys } from "./registry";
import { toToolCallViewProps } from "./adapter";
import { SkillRow } from "./SkillRow";
import "./dsw-theme.css";

let registered = false;

/** Register the built-in (vendored) dsh toolviews. Idempotent. */
export function registerBuiltinToolViews(): void {
  if (registered) return;
  registered = true;
  registerToolView("skill", SkillRow);
}

export function hasToolView(toolName: string): boolean {
  registerBuiltinToolViews();
  return getToolView(toolName) !== undefined;
}

export function DshToolView({
  tc,
  cwd,
  home,
  openFile,
  inspect,
}: {
  tc: ChatToolCall;
  cwd?: string;
  home?: string;
  openFile?: (p: string) => void;
  inspect?: () => void;
}): React.ReactElement | null {
  registerBuiltinToolViews();
  const View = getToolView(tc.tool);
  if (!View) return null;
  const props = toToolCallViewProps(tc, { cwd, home, openFile, inspect });
  return (
    <div className="dsh-toolview-scope">
      <View {...props} />
    </div>
  );
}

export { registerToolView, registeredToolViewKeys };
