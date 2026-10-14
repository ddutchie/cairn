import { create } from "zustand";
import { toolsClient } from "@/lib/ipc/tools";

/**
 * MCP servers that rejected a chat-time connect for missing OAuth credentials,
 * keyed by server id. Fed by main's `tools:authRequired` event; cleared when a
 * sign-in completes. Kept out of the main store: it is transient UI state that
 * every chat surface (chat, agent, overview launcher) shares.
 */
interface McpAuthRequiredState {
  servers: Record<string, string>;
  add: (serverId: string, serverName: string) => void;
  remove: (serverId: string) => void;
}

export const useMcpAuthRequired = create<McpAuthRequiredState>((set) => ({
  servers: {},
  add: (serverId, serverName) => set((s) => (s.servers[serverId] === serverName ? s : { servers: { ...s.servers, [serverId]: serverName } })),
  remove: (serverId) =>
    set((s) => {
      if (!(serverId in s.servers)) return s;
      const { [serverId]: _drop, ...rest } = s.servers;
      return { servers: rest };
    }),
}));

let subscribed = false;

/** Idempotent: wire the IPC events into the store once per renderer. */
export function subscribeMcpAuthRequired(): void {
  if (subscribed) return;
  subscribed = true;
  toolsClient.onAuthRequired((e) => useMcpAuthRequired.getState().add(e.serverId, e.serverName));
  toolsClient.onOauthCallback((e) => {
    if (e.status === "authorized" && e.serverId) useMcpAuthRequired.getState().remove(e.serverId);
  });
}
