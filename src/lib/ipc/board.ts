/**
 * Typed clients for board columns and task cards (`db:column:*`,
 * `db:card:*`). Every failure rejects with the main-process message;
 * off-Electron calls reject with `IpcUnavailableError`.
 */
import type {
  CardCreateInput,
  CardPatch,
  ColumnCreateInput,
  ColumnPatch,
} from "../../../shared/types/board";
import { domainCall, type ElectronApi } from "./client";

type ColumnApi = NonNullable<ElectronApi["column"]>;
const column = <T>(fn: (api: ColumnApi) => Promise<T>) => domainCall("column", fn);

export const columnsClient = {
  list: (projectId?: string) => column((c) => c.list(projectId)),
  create: (input: ColumnCreateInput) => column((c) => c.create(input)),
  update: (id: string, patch: ColumnPatch) => column((c) => c.update(id, patch)),
  delete: (id: string) => column((c) => c.delete(id)),
};

type CardApi = NonNullable<ElectronApi["card"]>;
const card = <T>(fn: (api: CardApi) => Promise<T>) => domainCall("card", fn);

export const cardsClient = {
  list: (opts?: { projectId?: string; columnId?: string }) => card((c) => c.list(opts)),
  create: (input: CardCreateInput) => card((c) => c.create(input)),
  update: (id: string, patch: CardPatch) => card((c) => c.update(id, patch)),
  moveToProject: (id: string, projectId: string, columnId: string, order: number) =>
    card((c) => c.moveToProject(id, projectId, columnId, order)),
  delete: (id: string) => card((c) => c.delete(id)),
  archiveDone: (columnId: string) => card((c) => c.archiveDone(columnId)),
  addBlocker: (cardId: string, blockerCardId: string) => card((c) => c.addBlocker(cardId, blockerCardId)),
  removeBlocker: (cardId: string, blockerCardId: string) =>
    card((c) => c.removeBlocker(cardId, blockerCardId)),
  ready: (projectId?: string) => card((c) => c.ready(projectId)),
};
