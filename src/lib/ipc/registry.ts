/**
 * Typed client for the community registry (`registry:*`). Every failure
 * rejects with the main-process message; off-Electron calls reject with
 * `IpcUnavailableError`.
 */
import { domainCall, type ElectronApi } from "./client";

type RegistryApi = NonNullable<ElectronApi["registry"]>;
const registry = <T>(fn: (api: RegistryApi) => Promise<T>) => domainCall("registry", fn);

export const registryClient = {
  /** Cache-first: instant/offline, background-revalidates. */
  fetch: () => registry((r) => r.fetch()),
  /** Force a network refresh (explicit Refresh button). */
  refresh: () => registry((r) => r.refresh()),
  /** Community AI providers (separate providers.json manifest). Cache-first. */
  fetchProviders: () => registry((r) => r.fetchProviders()),
  /** Force a network refresh of the providers manifest. */
  refreshProviders: () => registry((r) => r.refreshProviders()),
  /** Community automation recipes (separate automations.json manifest). Cache-first. */
  fetchAutomations: () => registry((r) => r.fetchAutomations()),
  /** Force a network refresh of the automations manifest. */
  refreshAutomations: () => registry((r) => r.refreshAutomations()),
  /** Community personalities (separate personalities.json manifest). Cache-first. */
  fetchPersonalities: () => registry((r) => r.fetchPersonalities()),
  /** Force a network refresh of the personalities manifest. */
  refreshPersonalities: () => registry((r) => r.refreshPersonalities()),
  /** Community chat themes (separate themes.json manifest). Cache-first. */
  fetchChatThemes: () => registry((r) => r.fetchChatThemes()),
  /** Force a network refresh of the chat themes manifest. */
  refreshChatThemes: () => registry((r) => r.refreshChatThemes()),
};
