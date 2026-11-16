/**
 * Typed clients for workspaces, projects, tags and the change feed
 * (`db:workspace:*`, `db:project:*`, `db:tag:*`, `db:snapshot`, `db:changes:*`,
 * `db:hasData`). Every failure rejects with the main-process message;
 * off-Electron calls reject with `IpcUnavailableError`.
 */
import type {
  ProjectCreateInput,
  ProjectPatch,
  ProjectSettings,
  TagCreateInput,
  TagPatch,
  WorkspaceCreateInput,
  WorkspacePatch,
} from "../../../shared/types/workspace";
import { domainCall, electronCall, type ElectronApi } from "./client";

type WorkspaceApi = NonNullable<ElectronApi["workspace"]>;
const workspace = <T>(fn: (api: WorkspaceApi) => Promise<T>) => domainCall("workspace", fn);

export const workspaceClient = {
  list: () => workspace((w) => w.list()),
  create: (input: WorkspaceCreateInput) => workspace((w) => w.create(input)),
  update: (id: string, patch: WorkspacePatch) => workspace((w) => w.update(id, patch)),
};

type ProjectApi = NonNullable<ElectronApi["project"]>;
const project = <T>(fn: (api: ProjectApi) => Promise<T>) => domainCall("project", fn);

export const projectClient = {
  list: (workspaceId?: string) => project((p) => p.list(workspaceId)),
  create: (input: ProjectCreateInput) => project((p) => p.create(input)),
  update: (id: string, patch: ProjectPatch) => project((p) => p.update(id, patch)),
  updateSettings: (id: string, settings: Partial<Record<keyof ProjectSettings, unknown>>) =>
    project((p) => p.updateSettings(id, settings)),
  delete: (id: string) => project((p) => p.delete(id)),
  merge: (sourceId: string, targetId: string) => project((p) => p.merge(sourceId, targetId)),
};

type TagApi = NonNullable<ElectronApi["tag"]>;
const tag = <T>(fn: (api: TagApi) => Promise<T>) => domainCall("tag", fn);

export const tagClient = {
  list: (workspaceId?: string) => tag((t) => t.list(workspaceId)),
  create: (input: TagCreateInput) => tag((t) => t.create(input)),
  update: (id: string, patch: TagPatch) => tag((t) => t.update(id, patch)),
  delete: (id: string) => tag((t) => t.delete(id)),
};

type ChangesApi = NonNullable<ElectronApi["changes"]>;
const changes = <T>(fn: (api: ChangesApi) => Promise<T>) => domainCall("changes", fn);

/** Full DB snapshot + change feed (top-level bridge keys). */
export const changesClient = {
  snapshot: (opts?: { noteBodies?: boolean }) => electronCall((e) => e.snapshot(opts)),
  get: (args: { since: number | null; feedId: string | null }) => changes((c) => c.get(args)),
  hasData: () => electronCall((e) => e.hasData()),
  onDbChanged: (cb: () => void): (() => void) =>
    window.electron?.onDbChanged?.(cb) ?? (() => {}),
};
