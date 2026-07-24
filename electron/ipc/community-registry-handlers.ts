/**
 * Community registry IPC — read/cache layer for the cairn-community catalog.
 *
 *   registry:fetch    cache-first (instant/offline); background-revalidates
 *   registry:refresh  force a network refresh (explicit "Refresh" button)
 *
 * Read-only: this card fetches + caches the manifest only. Install (writing the
 * chosen entry into mcp_servers / custom_services) is Registry 2.
 */

import { registerIpcHandle } from "./registry";
import { handle } from "./result-helpers";
import { fetchManifest, refreshManifest } from "../lib/community-registry";

export function registerCommunityRegistryHandlers(): void {
  registerIpcHandle("registry:fetch", () => handle(() => fetchManifest()));
  registerIpcHandle("registry:refresh", () => handle(() => refreshManifest()));
}
