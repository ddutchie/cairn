/**
 * Community registry — fetches + caches the cairn-community manifest on-device.
 *
 * Mirrors electron/lib/community-registry.ts but for mobile: the SAME manifest
 * (validated by the SAME shared parser) is fetched over HTTPS with a conditional
 * GET (stored ETag), and cached in the DEVICE-GLOBAL meta DB (getMeta/setMeta) so
 * a browse works offline and the catalog is available across every workspace.
 *
 * Pure validation lives in @cairn/shared/chat/registry-schema (Track 1); this
 * module only adds the platform I/O (expo/fetch + meta-DB cache). Nothing here
 * is synced — the registry is device-global config, not user content.
 */

import { fetch as expoFetch } from "expo/fetch";
import { parseManifest, type CommunityManifest, type RegistryServiceEntry } from "@cairn/shared/chat/registry-schema";
import { getMeta, setMeta } from "../db";

/** Same source of truth as the desktop MANIFEST_URL. */
const MANIFEST_URL = "https://raw.githubusercontent.com/ddutchie/cairn-community/main/manifest.json";

const META_MANIFEST = "registry.manifest"; // cached CommunityManifest JSON
const META_ETAG = "registry.etag"; // last ETag for conditional GET
const META_FETCHED_AT = "registry.fetchedAt"; // ISO of last successful fetch

/** Give up on a slow/hung manifest fetch and fall back to the cache. */
const FETCH_TIMEOUT_MS = 20_000;

// In-memory memo of the last parsed manifest, keyed by the raw JSON string it
// was parsed from. getCachedManifest() is called repeatedly (Tools screen init,
// getRegistryServices, tool assembly) and parseManifest re-validates the WHOLE
// manifest each time — expensive as the catalog grows. Caching by raw string
// keeps it correct (any setMeta write changes the raw → cache miss → re-parse)
// while skipping redundant JSON.parse + schema validation on the hot path.
let _memoRaw: string | null = null;
let _memoManifest: CommunityManifest | null = null;

/** The cached manifest, or null if nothing has been fetched yet / cache is corrupt. */
export function getCachedManifest(): CommunityManifest | null {
  const raw = getMeta(META_MANIFEST);
  if (!raw) {
    _memoRaw = null;
    _memoManifest = null;
    return null;
  }
  if (raw === _memoRaw) return _memoManifest;
  try {
    const manifest = parseManifest(JSON.parse(raw));
    _memoRaw = raw;
    _memoManifest = manifest;
    return manifest;
  } catch {
    // A corrupt cache should never break browse — treat as "no cache".
    _memoRaw = null;
    _memoManifest = null;
    return null;
  }
}

/** ISO timestamp of the last successful manifest fetch, or null. */
export function getManifestFetchedAt(): string | null {
  return getMeta(META_FETCHED_AT);
}

/**
 * Fetch the manifest with a conditional GET. On 304 (or any network error) the
 * cached manifest is returned unchanged. On 200 the body is validated + cached.
 * Never throws — returns { manifest, error? } so the UI can show a soft error
 * while still rendering the cache.
 */
export async function fetchManifest(force = false): Promise<{ manifest: CommunityManifest | null; error?: string }> {
  const cached = getCachedManifest();
  const etag = force ? null : getMeta(META_ETAG);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await expoFetch(MANIFEST_URL, {
      method: "GET",
      headers: etag ? { "If-None-Match": etag } : {},
      signal: controller.signal,
    });
    if (res.status === 304) {
      return { manifest: cached };
    }
    if (!res.ok) {
      return { manifest: cached, error: `Registry fetch failed (${res.status}).` };
    }
    const text = await res.text();
    // Validate BEFORE caching so a malformed upstream never poisons the cache.
    const manifest = parseManifest(JSON.parse(text));
    setMeta(META_MANIFEST, text);
    const newEtag = res.headers.get("etag");
    if (newEtag) setMeta(META_ETAG, newEtag);
    setMeta(META_FETCHED_AT, new Date().toISOString());
    return { manifest };
  } catch (e) {
    const msg = controller.signal.aborted
      ? "Registry fetch timed out."
      : e instanceof Error
        ? e.message
        : String(e);
    return { manifest: cached, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience: the service entries from the (cached or freshly-fetched) manifest. */
export function getRegistryServices(): RegistryServiceEntry[] {
  return getCachedManifest()?.services ?? [];
}
