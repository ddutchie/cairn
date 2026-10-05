/** Workspaces, projects, tags, slash commands, snapshot + change feed. */

import { invokeContract, onIpcEvent } from "./ipc";
import type { ProjectCreateInput, ProjectPatch, ProjectSettings, SlashCommandCreateInput, SlashCommandPatch, TagCreateInput, TagPatch, WorkspaceCreateInput, WorkspacePatch } from "../../shared/types/workspace";

export const workspaceApi = {
  // ── Full snapshot ────────────────────────────
  snapshot: (opts?: { noteBodies?: boolean }) => invokeContract("db:snapshot", opts),
  // ── Change feed (cursor-based incremental refresh) ──
  changes: {
    get: (args: { since: number | null; feedId: string | null }) => invokeContract("db:changes:get", args),
  },
  hasData:  () => invokeContract("db:hasData"),

  // ── Workspaces ───────────────────────────────
  workspace: {
    list:   () => invokeContract("db:workspace:list"),
    create: (input: WorkspaceCreateInput) => invokeContract("db:workspace:create", input),
    update: (id: string, patch: WorkspacePatch) => invokeContract("db:workspace:update", { id, patch }),
  },

  // ── Projects ─────────────────────────────────
  project: {
    list:   (workspaceId?: string) => invokeContract("db:project:list", { workspaceId }),
    create: (input: ProjectCreateInput) => invokeContract("db:project:create", input),
    update: (id: string, patch: ProjectPatch) => invokeContract("db:project:update", { id, patch }),
    updateSettings: (id: string, settings: Partial<Record<keyof ProjectSettings, unknown>>) =>
      invokeContract("db:project:updateSettings", { id, settings }),
    delete: (id: string) => invokeContract("db:project:delete", { id }),
    merge:  (sourceId: string, targetId: string) => invokeContract("db:project:merge", { sourceId, targetId }),
  },

  // ── Tags ─────────────────────────────────────
  tag: {
    list:   (workspaceId?: string) => invokeContract("db:tag:list", { workspaceId }),
    create: (input: TagCreateInput) => invokeContract("db:tag:create", input),
    update: (id: string, patch: TagPatch) => invokeContract("db:tag:update", { id, patch }),
    delete: (id: string) => invokeContract("db:tag:delete", { id }),
  },

  // ── Slash commands ───────────────────────────
  command: {
    list:   (workspaceId?: string) => invokeContract("db:command:list", { workspaceId }),
    create: (input: SlashCommandCreateInput) => invokeContract("db:command:create", input),
    update: (id: string, patch: SlashCommandPatch) => invokeContract("db:command:update", { id, patch }),
    delete: (id: string) => invokeContract("db:command:delete", { id }),
  },

  // ── DB change notifications (from MCP writes) ─
  onDbChanged: (cb: () => void) => onIpcEvent("db:changed", () => cb()),

  // ── Dashboard live query bridge ───────────────
  mcpQuery: (tool: string, args: Record<string, unknown>) => invokeContract("db:mcpQuery", { tool, args }),
} as const;
