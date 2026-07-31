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
import type { CustomSlashCommand, ID, SlashCommandScope } from "@/types";
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
});
