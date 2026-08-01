/**
 * Community providers registry — fetches + caches the cairn-community
 * `providers.json` manifest on-device.
 *
 * Mirrors electron/lib/community-registry.ts (the providers half) and mobile's
 * own registry.ts (the tools/commands half): the SAME providers manifest,
 * validated by the SAME shared parser, fetched over HTTPS with a conditional GET
 * (stored ETag) and cached in the DEVICE-GLOBAL meta DB so browse works offline
 * and the catalog is shared across every workspace.
 *
 * Providers live in a SEPARATE manifest from the tools/commands catalog, so this
 * is a parallel module to registry.ts — same shape, different URL + cache keys.
 * Nothing here is synced — the registry is device-global config, not user content.
 */

import { fetch as expoFetch } from "expo/fetch";
import {
  parseProvidersManifest,
  type ProvidersManifest,
  type RegistryProviderEntry,
} from "@cairn/shared/chat/registry-schema";
import { getMeta, setMeta } from "../db";

/** Same source of truth as the desktop PROVIDERS_URL. */
const PROVIDERS_URL = "https://raw.githubusercontent.com/ddutchie/cairn-community/main/providers.json";

const META_MANIFEST = "registry.providers"; // cached ProvidersManifest JSON
const META_ETAG = "registry.providers.etag"; // last ETag for conditional GET
const META_FETCHED_AT = "registry.providers.fetchedAt"; // ISO of last successful fetch

/** Give up on a slow/hung manifest fetch and fall back to the cache. */
const FETCH_TIMEOUT_MS = 20_000;

// In-memory memo of the last parsed manifest, keyed by the raw JSON string it
// was parsed from — skips redundant JSON.parse + schema validation on the hot
// path while staying correct (any setMeta write changes the raw → re-parse).
let _memoRaw: string | null = null;
let _memoManifest: ProvidersManifest | null = null;

/** The cached providers manifest, or null if nothing fetched yet / cache corrupt. */
export function getCachedProvidersManifest(): ProvidersManifest | null {
  const raw = getMeta(META_MANIFEST);
  if (!raw) {
    _memoRaw = null;
    _memoManifest = null;
    return null;
  }
  if (raw === _memoRaw) return _memoManifest;
  try {
    const manifest = parseProvidersManifest(JSON.parse(raw));
    _memoRaw = raw;
    _memoManifest = manifest;
    return manifest;
  } catch {
    _memoRaw = null;
    _memoManifest = null;
    return null;
  }
}

/** ISO timestamp of the last successful providers-manifest fetch, or null. */
export function getProvidersFetchedAt(): string | null {
  return getMeta(META_FETCHED_AT);
}

/**
 * Fetch the providers manifest with a conditional GET. On 304 (or any network
 * error) the cached manifest is returned unchanged. On 200 the body is validated
 * + cached. Never throws — returns { manifest, error? } so the UI can show a soft
 * error while still rendering the cache.
 *
 * A forced refresh is a HARD refresh (mirrors desktop): it skips the ETag and
 * cache-busts the URL so a stale CDN edge can't answer 304 with old content.
 */
export async function fetchProvidersManifest(
  force = false,
): Promise<{ manifest: ProvidersManifest | null; error?: string }> {
  const cached = getCachedProvidersManifest();
  const etag = force ? null : getMeta(META_ETAG);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = force ? `${PROVIDERS_URL}?_cb=${Date.now()}` : PROVIDERS_URL;
    const res = await expoFetch(url, {
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
    const manifest = parseProvidersManifest(JSON.parse(text));
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

/** Convenience: provider entries from the (cached or freshly-fetched) manifest. */
export function getRegistryProviders(): RegistryProviderEntry[] {
  return getCachedProvidersManifest()?.providers ?? [];
}
