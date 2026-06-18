/**
 * Cairn — IPC handler for `db:flow:url:fetch`.
 *
 * Fetches OG metadata for a URL (title + description) so the user can confirm
 * the URL is what they intended before committing it to the Idea Flow as a
 * `url` node. The actual HTTP fetch + OG parsing lives in
 * `electron/lib/url-metadata.ts` (main-process, no CORS).
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerIpcHandle } from "./registry";
import { handle } from "./result-helpers";
import { fetchUrlMetadata } from "../lib/url-metadata";

export function registerUrlMetadataHandler(): void {
  registerIpcHandle("db:flow:url:fetch", (_e, { url }: { url: string }) =>
    handle(() => fetchUrlMetadata(url))
  );
}
