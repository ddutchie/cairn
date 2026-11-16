/**
 * Typed client for community slash commands (`db:command:*`). Every failure
 * rejects with the main-process message; off-Electron calls reject with
 * `IpcUnavailableError`.
 */
import type { SlashCommandCreateInput, SlashCommandPatch } from "../../../shared/types/workspace";
import { domainCall, type ElectronApi } from "./client";

type CommandApi = NonNullable<ElectronApi["command"]>;
const command = <T>(fn: (api: CommandApi) => Promise<T>) => domainCall("command", fn);

export const commandsClient = {
  list: (workspaceId?: string) => command((c) => c.list(workspaceId)),
  create: (input: SlashCommandCreateInput) => command((c) => c.create(input)),
  update: (id: string, patch: SlashCommandPatch) => command((c) => c.update(id, patch)),
  delete: (id: string) => command((c) => c.delete(id)),
};
