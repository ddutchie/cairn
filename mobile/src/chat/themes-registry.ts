/**
 * Community chat themes registry — fetches + caches the cairn-community
 * `themes.json` manifest on-device.
 *
 * Mirrors mobile's personalities-registry.ts (same fetch/cache pattern) and the
 * desktop's chat-themes half of electron/lib/community-registry.ts: the SAME
 * manifest, validated by the SAME shared parser, fetched over HTTPS with a
 * conditional GET (stored ETag) and cached in the DEVICE-GLOBAL meta DB so the
 * theme picker works offline. Themes are pure JSON (system fonts, solid/
 * gradient/scanline backgrounds, fixed palette fields) — safe to hot-load.
 */

import { fetch as expoFetch } from "expo/fetch";
import {
  parseChatThemesManifest,
  type ChatThemesManifest,
} from "@cairn/shared/chat/registry-schema";
import { getMeta, setMeta } from "../db";

/** Same source of truth as the desktop CHAT_THEMES_URL. */
const CHAT_THEMES_URL = "https://raw.githubusercontent.com/ddutchie/cairn-community/main/themes.json";

const META_MANIFEST = "registry.themes"; // cached ChatThemesManifest JSON
const META_ETAG = "registry.themes.etag"; // last ETag for conditional GET
const META_FETCHED_AT = "registry.themes.fetchedAt"; // ISO of last successful fetch

/** Give up on a slow/hung manifest fetch and fall back to the cache. */
const FETCH_TIMEOUT_MS = 20_000;

let _memoRaw: string | null = null;
let _memoManifest: ChatThemesManifest | null = null;

/** The cached chat-themes manifest, or null if nothing fetched yet / cache corrupt. */
export function getCachedThemesManifest(): ChatThemesManifest | null {
  const raw = getMeta(META_MANIFEST);
  if (!raw) {
    _memoRaw = null;
    _memoManifest = null;
    return null;
  }
  if (raw === _memoRaw) return _memoManifest;
  try {
    const manifest = parseChatThemesManifest(JSON.parse(raw));
    _memoRaw = raw;
    _memoManifest = manifest;
    return manifest;
  } catch {
    _memoRaw = null;
    _memoManifest = null;
    return null;
  }
}

/** ISO timestamp of the last successful themes-manifest fetch, or null. */
export function getThemesFetchedAt(): string | null {
  return getMeta(META_FETCHED_AT);
}

/**
 * Fetch the chat-themes manifest with a conditional GET. On 304 (or any network
 * error) the cached manifest is returned unchanged. On 200 the body is
 * validated + cached. Never throws — returns { manifest, error? } so the UI can
 * show a soft error while still rendering the cache.
 */
export async function fetchChatThemesManifest(): Promise<{
  manifest: ChatThemesManifest | null;
  error?: string;
}> {
  const cached = getCachedThemesManifest();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const etag = getMeta(META_ETAG);
    // Conditional GET only when we have a valid cached manifest to fall back
    // to — with a stale ETag but no cache, a 304 would wrongly return null
    // instead of downloading.
    const fetchOnce = (withEtag: boolean) =>
      expoFetch(CHAT_THEMES_URL, {
        headers: withEtag && etag ? { "If-None-Match": etag } : {},
        signal: controller.signal,
      });
    let res = await fetchOnce(cached != null);
    if (res.status === 304) {
      if (cached) return { manifest: cached };
      // Stale ETag but no valid cache — re-download the full manifest without
      // the conditional header.
      res = await fetchOnce(false);
    }
    if (!res.ok) {
      return { manifest: cached, error: `Registry responded ${res.status}` };
    }
    const text = await res.text();
    let manifest: ChatThemesManifest;
    try {
      manifest = parseChatThemesManifest(JSON.parse(text));
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
  } finally {
    clearTimeout(timer);
  }
}
