/**
 * Community registry IPC — read/cache layer for the cairn-community catalog.
 *
 *   registry:fetch    cache-first (instant/offline); background-revalidates
 *   registry:refresh  force a network refresh (explicit "Refresh" button)
 *
 * Read-only: this card fetches + caches the manifest only. Install (writing the
 * chosen entry into mcp_servers / custom_services) is Registry 2.
 */

import { registerContractHandle } from "./registry";
import { handle } from "./result-helpers";
import {
  fetchManifest,
  refreshManifest,
  fetchProvidersManifest,
  refreshProvidersManifest,
  fetchAutomationsManifest,
  refreshAutomationsManifest,
  fetchPersonalitiesManifest,
  refreshPersonalitiesManifest,
  fetchChatThemesManifest,
  refreshChatThemesManifest,
} from "../lib/community-registry";

export function registerCommunityRegistryHandlers(): void {
  registerContractHandle("registry:fetch", () => handle(() => fetchManifest()));
  registerContractHandle("registry:refresh", () => handle(() => refreshManifest()));
  // Providers live in a SEPARATE manifest (providers.json) so the catalogs can
  // evolve independently.
  registerContractHandle("registry:fetchProviders", () => handle(() => fetchProvidersManifest()));
  registerContractHandle("registry:refreshProviders", () => handle(() => refreshProvidersManifest()));
  // Automations live in a SEPARATE manifest (automations.json), same rationale.
  registerContractHandle("registry:fetchAutomations", () => handle(() => fetchAutomationsManifest()));
  registerContractHandle("registry:refreshAutomations", () => handle(() => refreshAutomationsManifest()));
  // Personalities live in a SEPARATE manifest (personalities.json), same rationale.
  registerContractHandle("registry:fetchPersonalities", () => handle(() => fetchPersonalitiesManifest()));
  registerContractHandle("registry:refreshPersonalities", () => handle(() => refreshPersonalitiesManifest()));
  // Chat themes live in a SEPARATE manifest (themes.json), same rationale — new
  // themes ship without an app update.
  registerContractHandle("registry:fetchChatThemes", () => handle(() => fetchChatThemesManifest()));
  registerContractHandle("registry:refreshChatThemes", () => handle(() => refreshChatThemesManifest()));
}
