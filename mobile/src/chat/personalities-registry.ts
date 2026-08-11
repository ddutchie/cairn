/**
 * Community personalities registry — fetches + caches the cairn-community
 * `personalities.json` manifest on-device.
 *
 * Mirrors mobile's providers-registry.ts (same fetch/cache pattern) and the
 * desktop's personalities half of electron/lib/community-registry.ts: the SAME
 * manifest, validated by the SAME shared parser, fetched over HTTPS with a
 * conditional GET (stored ETag) and cached in the DEVICE-GLOBAL meta DB so the
 * picker works offline. Nothing here is synced — the registry is device-global
 * config, not user content.
 */

import { fetch as expoFetch } from "expo/fetch";
import {
  parsePersonalitiesManifest,
  type PersonalitiesManifest,
} from "@cairn/shared/chat/registry-schema";
import { getMeta, setMeta } from "../db";

/** Same source of truth as the desktop PERSONALITIES_URL. */
const PERSONALITIES_URL = "https://raw.githubusercontent.com/ddutchie/cairn-community/main/personalities.json";

const META_MANIFEST = "registry.personalities"; // cached PersonalitiesManifest JSON
const META_ETAG = "registry.personalities.etag"; // last ETag for conditional GET
const META_FETCHED_AT = "registry.personalities.fetchedAt"; // ISO of last successful fetch

/** Give up on a slow/hung manifest fetch and fall back to the cache. */
const FETCH_TIMEOUT_MS = 20_000;

let _memoRaw: string | null = null;
let _memoManifest: PersonalitiesManifest | null = null;

/** The cached personalities manifest, or null if nothing fetched yet / cache corrupt. */
export function getCachedPersonalitiesManifest(): PersonalitiesManifest | null {
  const raw = getMeta(META_MANIFEST);
  if (!raw) {
    _memoRaw = null;
    _memoManifest = null;
    return null;
  }
  if (raw === _memoRaw) return _memoManifest;
  try {
    const manifest = parsePersonalitiesManifest(JSON.parse(raw));
    _memoRaw = raw;
    _memoManifest = manifest;
    return manifest;
  } catch {
    _memoRaw = null;
    _memoManifest = null;
    return null;
  }
}

/** ISO timestamp of the last successful personalities-manifest fetch, or null. */
export function getPersonalitiesFetchedAt(): string | null {
  return getMeta(META_FETCHED_AT);
}

/**
 * Fetch the personalities manifest with a conditional GET. On 304 (or any
 * network error) the cached manifest is returned unchanged. On 200 the body is
 * validated + cached. Never throws — returns { manifest, error? } so the UI can
 * show a soft error while still rendering the cache.
 */
export async function fetchPersonalitiesManifest(): Promise<{
  manifest: PersonalitiesManifest | null;
  error?: string;
}> {
  const cached = getCachedPersonalitiesManifest();
  try {
    const etag = getMeta(META_ETAG);
    const headers: Record<string, string> = {};
    if (etag) headers["If-None-Match"] = etag;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await expoFetch(PERSONALITIES_URL, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (res.status === 304) {
      return { manifest: cached };
    }
    if (!res.ok) {
      return { manifest: cached, error: `Registry responded ${res.status}` };
    }
    const text = await res.text();
    let manifest: PersonalitiesManifest;
    try {
      manifest = parsePersonalitiesManifest(JSON.parse(text));
    } catch {
      return { manifest: cached, error: "Registry manifest was invalid" };
    }
    setMeta(META_MANIFEST, text);
    setMeta(META_FETCHED_AT, new Date().toISOString());
    const newEtag = res.headers.get("etag");
    if (newEtag) setMeta(META_ETAG, newEtag);
    _memoRaw = text;
    _memoManifest = manifest;
    return { manifest };
  } catch (err) {
    return { manifest: cached, error: err instanceof Error ? err.message : "Registry fetch failed" };
  }
}
