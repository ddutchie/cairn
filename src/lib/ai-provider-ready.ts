/** The connection fields shared by the chat (`aiConfig`) and agent (`agentConfig`) configs. */
export interface ProviderConnection {
  baseUrl?: string;
  apiKey?: string;
  activeProviderId?: string;
}

const LOCAL_ENDPOINT = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;

/**
 * True when a surface can send a turn: it has a key, the user selected a saved
 * provider (the key is optional there, since self-hosted servers on a LAN or
 * private domain often need none), or the endpoint is on this machine.
 *
 * Checks the active connection only. A key saved on another provider doesn't
 * help, because that key isn't the one the request would use.
 */
export function isAIProviderReady(
  config: ProviderConnection,
  savedProviders: ReadonlyArray<{ id: string }> = [],
): boolean {
  if (config.apiKey?.trim()) return true;
  if (config.activeProviderId && savedProviders.some((p) => p.id === config.activeProviderId)) return true;
  return LOCAL_ENDPOINT.test(config.baseUrl ?? "");
}
