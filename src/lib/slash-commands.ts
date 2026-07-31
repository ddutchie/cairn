/**
 * Slash command registry — built-in commands + the merge with user-defined /
 * community commands from the store.
 *
 * Built-in commands are code constants (some are intercepted and *executed* by
 * the chat/agent send paths — e.g. `/compact`, `/archive-chat`; others just
 * insert a prompt template). User-defined + community commands are persisted in
 * the `slash_commands` table and loaded into `customCommands` by the commands
 * slice. `getCommandsForScope` merges the two into the flat `SlashCommand[]`
 * shape the ChatInput palette consumes, de-duplicating by name (a custom command
 * overrides a built-in of the same name).
 */

import type { SlashCommand } from "@/components/chat/ChatInput";
import type { CustomSlashCommand, SlashCommandScope } from "@/types";

/** A built-in command definition (paired with an input pane scope). */
export interface BuiltinSlashCommand extends SlashCommand {
  scope: SlashCommandScope;
}

/**
 * Built-in chat-panel commands. `/compact` and `/archive-chat` are intercepted
 * and executed by the chat panel's send handler; the rest insert prompt text.
 */
export const BUILTIN_CHAT_COMMANDS: BuiltinSlashCommand[] = [
  { name: "archive-chat", description: "Archive conversation as a note & clear chat", insertText: "/archive-chat", scope: "chat" },
  { name: "compact", description: "Summarise and compact conversation history", insertText: "/compact", scope: "chat" },
  { name: "board", description: "Show all task board columns and cards", insertText: "List the current task board columns and cards.", scope: "chat" },
  { name: "review-note", description: "Ask AI to review a note", insertText: 'Please review my note "[note title]" and suggest improvements.', scope: "chat" },
];

/**
 * Built-in coding-agent commands. `/compact` is intercepted by the agent pane;
 * the rest insert prompt text.
 */
export const BUILTIN_AGENT_COMMANDS: BuiltinSlashCommand[] = [
  { name: "compact", description: "Summarise and compact conversation history", insertText: "/compact", scope: "agent" },
  { name: "code-review", description: "Review recent git changes for bugs and style", insertText: "Please run a code review of the recent changes. Run git diff and analyze it.", scope: "agent" },
  { name: "spawn-subagent", description: "Spawn a subagent to work on a task", insertText: '/spawn-subagent task: "write tests for..."', scope: "agent" },
  { name: "test", description: "Run project tests and verify correctness", insertText: "Run the project tests and report if they pass.", scope: "agent" },
];

/**
 * All built-ins, for the Settings documentation view. A command defined in BOTH
 * the chat and agent lists (e.g. `/compact`) is merged into a single entry with
 * a combined `both` scope; chat-only and agent-only commands keep their scope
 * and metadata.
 */
export const ALL_BUILTIN_COMMANDS: BuiltinSlashCommand[] = (() => {
  const byName = new Map<string, BuiltinSlashCommand>();
  for (const c of [...BUILTIN_CHAT_COMMANDS, ...BUILTIN_AGENT_COMMANDS]) {
    const existing = byName.get(c.name);
    if (!existing) {
      byName.set(c.name, { ...c });
    } else if (existing.scope !== c.scope) {
      // Same name across chat + agent → surface as available in both panes.
      byName.set(c.name, { ...existing, scope: "both" });
    }
  }
  return [...byName.values()];
})();

function scopeMatches(scope: SlashCommandScope, target: "chat" | "agent"): boolean {
  return scope === "both" || scope === target;
}

/**
 * Built-in commands that are intercepted and *executed* by the send path (not
 * merely inserted as prompt text). A custom command with one of these names
 * would be shadowed by the interceptor, so creating one is rejected.
 */
export const RESERVED_COMMAND_NAMES = ["compact", "archive-chat"] as const;

/** True when `name` collides with a reserved, executable built-in command. */
export function isReservedCommandName(name: string): boolean {
  return (RESERVED_COMMAND_NAMES as readonly string[]).includes(name);
}

/**
 * Merge built-in commands for a pane with the workspace's custom/community
 * commands, filtered by scope. A custom command with the same name as a built-in
 * overrides it, so users can tweak a built-in's inserted text.
 */
export function getCommandsForScope(
  target: "chat" | "agent",
  customCommands: CustomSlashCommand[]
): SlashCommand[] {
  const builtins = target === "chat" ? BUILTIN_CHAT_COMMANDS : BUILTIN_AGENT_COMMANDS;
  const scopedCustom = customCommands.filter((c) => scopeMatches(c.scope, target));
  const customNames = new Set(scopedCustom.map((c) => c.name));

  const merged: SlashCommand[] = [
    ...builtins
      .filter((b) => !customNames.has(b.name))
      .map((b) => ({ name: b.name, description: b.description, insertText: b.insertText })),
    ...scopedCustom.map((c) => ({ name: c.name, description: c.description, insertText: c.insertText })),
  ];

  return merged.sort((a, b) => a.name.localeCompare(b.name));
}
