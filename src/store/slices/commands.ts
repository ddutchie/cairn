/**
 * Slash Commands slice.
 *
 * Manages workspace-global, user-defined (and community-installed) slash
 * commands that surface in the chat / agent input palettes. Built-in commands
 * are code constants (see lib/slash-commands.ts) and are NOT stored here — this
 * slice only holds the persisted custom/community rows from the `slash_commands`
 * table, loaded via the `command:*` IPC channels.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { CustomSlashCommand, ID, RegistryCommandEntry, SlashCommandScope } from "@/types";
import { id } from "@/lib/utils";

// ── Slice interface ───────────────────────────────────────────────────────────

export interface CommandsSlice {
  /** Persisted custom + community slash commands for the active workspace. */
  customCommands: CustomSlashCommand[];

  fetchCommands: (workspaceId: ID) => Promise<void>;
  createCommand: (input: {
    workspaceId: ID;
    name: string;
    description: string;
    insertText: string;
    scope: SlashCommandScope;
    source?: "custom" | "community";
    communityId?: string;
  }) => Promise<void>;
  updateCommand: (
    id: ID,
    patch: Partial<Pick<CustomSlashCommand, "name" | "description" | "insertText" | "scope">>
  ) => Promise<void>;
  deleteCommand: (id: ID) => Promise<void>;
  /**
   * Install (or update) a command from the cairn-community registry. Re-installs
   * onto the SAME row when the community entry is already present, so an update
   * preserves the id instead of creating a duplicate. Returns the row id.
   */
  installCommunityCommand: (entry: RegistryCommandEntry) => Promise<ID>;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createCommandsSlice: StateCreator<CairnStore, [], [], CommandsSlice> = (
  set,
  get
) => ({
  customCommands: [],

  async fetchCommands(workspaceId) {
    if (typeof window === "undefined" || !window.electron?.command) return;
    try {
      const rows = (await window.electron.command.list(workspaceId)) as CustomSlashCommand[];
      // Guard against a stale response after the workspace changed mid-flight.
      if (get().activeWorkspaceId && get().activeWorkspaceId !== workspaceId) return;
      set({ customCommands: rows });
    } catch (err) {
      console.error("[commands] fetchCommands error", err);
    }
  },

  async createCommand(input) {
    if (typeof window === "undefined" || !window.electron?.command) return;
    try {
      const saved = (await window.electron.command.create({
        id: id(),
        workspaceId: input.workspaceId,
        name: input.name,
        description: input.description,
        insertText: input.insertText,
        scope: input.scope,
        source: input.source ?? "custom",
        communityId: input.communityId,
      })) as CustomSlashCommand;
      set((s) => ({ customCommands: [...s.customCommands, saved] }));
    } catch (err) {
      console.error("[commands] createCommand error", err);
    }
  },

  async updateCommand(commandId, patch) {
    if (typeof window === "undefined" || !window.electron?.command) return;
    try {
      const saved = (await window.electron.command.update(commandId, patch)) as CustomSlashCommand;
      set((s) => ({
        customCommands: s.customCommands.map((c) => (c.id === commandId ? saved : c)),
      }));
    } catch (err) {
      console.error("[commands] updateCommand error", err);
    }
  },

  async deleteCommand(commandId) {
    if (typeof window === "undefined" || !window.electron?.command) return;
    // Optimistic — roll back by re-fetching if the IPC call fails.
    const prev = get().customCommands;
    set({ customCommands: prev.filter((c) => c.id !== commandId) });
    try {
      await window.electron.command.delete(commandId);
    } catch (err) {
      console.error("[commands] deleteCommand error", err);
      set({ customCommands: prev });
    }
  },

  async installCommunityCommand(entry) {
    if (typeof window === "undefined" || !window.electron?.command) {
      throw new Error("Unavailable");
    }
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) throw new Error("No active workspace");

    const def = entry.definition;
    // Re-install onto an existing row instead of duplicating. Match by
    // communityId (an update to the same community entry) OR by name (a
    // pre-existing custom/community command with the same trigger) so a second
    // install never creates a duplicate /name in the workspace.
    const commands = get().customCommands.filter((c) => c.workspaceId === workspaceId);
    const existing =
      commands.find((c) => c.communityId === entry.id) ??
      commands.find((c) => c.name === def.name);

    if (existing) {
      const saved = (await window.electron.command.update(existing.id, {
        name: def.name,
        description: def.description ?? "",
        insertText: def.insertText,
        scope: def.scope,
      })) as CustomSlashCommand;
      set((s) => ({
        customCommands: s.customCommands.map((c) => (c.id === existing.id ? saved : c)),
      }));
      return existing.id;
    }

    const saved = (await window.electron.command.create({
      id: id(),
      workspaceId,
      name: def.name,
      description: def.description ?? "",
      insertText: def.insertText,
      scope: def.scope,
      source: "community",
      communityId: entry.id,
    })) as CustomSlashCommand;
    set((s) => ({ customCommands: [...s.customCommands, saved] }));
    return saved.id;
  },
});
