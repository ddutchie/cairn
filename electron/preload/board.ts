/** Board columns and task cards. */

import { invokeContract } from "./ipc";
import type { CardCreateInput, CardPatch, ColumnCreateInput, ColumnPatch } from "../../shared/types/board";

export const boardApi = {
  // ── Board columns ─────────────────────────────
  column: {
    list:   (projectId?: string) => invokeContract("db:column:list", { projectId }),
    create: (input: ColumnCreateInput) => invokeContract("db:column:create", input),
    update: (id: string, patch: ColumnPatch) => invokeContract("db:column:update", { id, patch }),
    delete: (id: string) => invokeContract("db:column:delete", { id }),
  },

  // ── Task cards ────────────────────────────────
  card: {
    list:         (opts?: { projectId?: string; columnId?: string }) => invokeContract("db:card:list", opts),
    create:       (input: CardCreateInput) => invokeContract("db:card:create", input),
    update:       (id: string, patch: CardPatch) => invokeContract("db:card:update", { id, patch }),
    moveToProject:(id: string, projectId: string, columnId: string, order: number) =>
      invokeContract("db:card:moveToProject", { id, projectId, columnId, order }),
    delete:       (id: string) => invokeContract("db:card:delete", { id }),
    archiveDone:  (columnId: string) => invokeContract("db:cards:archive-done", { columnId }),
    addBlocker:   (cardId: string, blockerCardId: string) => invokeContract("db:card:addBlocker", { cardId, blockerCardId }),
    removeBlocker:(cardId: string, blockerCardId: string) => invokeContract("db:card:removeBlocker", { cardId, blockerCardId }),
    ready:        (projectId?: string) => invokeContract("db:card:ready", { projectId }),
  },
} as const;
