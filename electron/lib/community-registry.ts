/**
 * Community registry — fetches and caches the cairn-community manifest.
 *
 * The manifest (https://github.com/ddutchie/cairn-community/blob/main/manifest.json)
 * is the catalog of installable MCP servers + HTTP services. This module owns:
 *   - fetching manifest.json over HTTPS (conditional GET via stored ETag)
 *   - caching the last good manifest + ETag in userData (offline resilience)
 *   - Zod-validating the payload before it is trusted
 *
 * Fail-soft: any network/parse failure falls back to the cached manifest; only a
 * failure with NO cache surfaces an error. Install (Registry 2) and the browse
 * UI live elsewhere — this is the read/cache layer only.
 *
 * Runs in the Electron main process. No `electron` static import at module load
 * (mirrors config-cache) so the userData path resolves in tests too.
 */

import fs from "fs";
import path from "path";
import { findUserDataDir } from "../runtime/port-discovery";
import {
  parseManifest,
  parseProvidersManifest,
  type CommunityManifest,
  type ProvidersManifest,
} from "../../shared/chat/registry-schema";

// Manifest TYPES + Zod validation now live in shared/chat/registry-schema.ts so
// desktop and mobile validate the catalog identically. Re-export the types so
// existing electron importers keep resolving them from here.
export type {
  CommunityManifest,
  ProvidersManifest,
  RegistryMcpEntry,
  RegistryServiceEntry,
  RegistryProviderEntry,
  RegistryEntryMeta,
} from "../../shared/chat/registry-schema";
export { parseManifest, parseProvidersManifest } from "../../shared/chat/registry-schema";

export interface RegistryFetchResult {
  manifest: CommunityManifest;
  fromCache: boolean;
  cachedAt?: string;
  error?: string;
}

export interface ProvidersFetchResult {
  manifest: ProvidersManifest;
  fromCache: boolean;
  cachedAt?: string;
  error?: string;
}

const MANIFEST_URL =
  "https://raw.githubusercontent.com/ddutchie/cairn-community/main/manifest.json";
const PROVIDERS_URL =
  "https://raw.githubusercontent.com/ddutchie/cairn-community/main/providers.json";
const CACHE_FILE = "community-registry.json";
const PROVIDERS_CACHE_FILE = "community-providers.json";
const FETCH_TIMEOUT_MS = 10_000;

// ── generic cache + fetch core (shared by both manifests) ───────────────────

interface CacheEnvelope<M> {
  etag?: string;
  cachedAt: string;
  manifest: M;
}

function cacheFilePath(file: string): string | null {
  const dir = findUserDataDir();
  return dir ? path.join(dir, file) : null;
}

function readCacheFile<M>(file: string, parse: (raw: unknown) => M): CacheEnvelope<M> | null {
  const p = cacheFilePath(file);
  if (!p || !fs.existsSync(p)) return null;
  try {
    const env = JSON.parse(fs.readFileSync(p, "utf8")) as CacheEnvelope<M>;
    // Re-validate the cached manifest so a corrupted/older-shape file can't feed
    // an invalid manifest downstream.
    env.manifest = parse(env.manifest);
    return env;
  } catch {
    return null;
  }
}

function writeCacheFile<M>(file: string, env: CacheEnvelope<M>): void {
  const p = cacheFilePath(file);
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Atomic write (tmp + rename) so a crash mid-write can't leave partial JSON.
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(env), "utf8");
    fs.renameSync(tmp, p);
  } catch {
    /* best-effort cache; a failure just means the next launch refetches */
  }
}

interface FetchSpec<M> {
  url: string;
  file: string;
  parse: (raw: unknown) => M;
  /** Empty manifest returned when the network fails AND there is no cache. */
  empty: M;
}

interface CoreResult<M> {
  manifest: M;
  fromCache: boolean;
  cachedAt?: string;
  error?: string;
}

/**
 * Generic cache-first fetch used by both the tools/commands manifest and the
 * providers manifest. Serves the cache immediately (background-revalidating)
 * unless force:true, uses a conditional GET via the stored ETag, and fails soft
 * to the cached copy on any network/parse error.
 */
async function fetchGeneric<M>(spec: FetchSpec<M>, opts?: { force?: boolean }): Promise<CoreResult<M>> {
  const cache = readCacheFile(spec.file, spec.parse);

  if (cache && !opts?.force) {
    void revalidateGeneric(spec, cache);
    return { manifest: cache.manifest, fromCache: true, cachedAt: cache.cachedAt };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(spec.url, {
        signal: controller.signal,
        headers: cache?.etag ? { "If-None-Match": cache.etag } : {},
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 304 && cache) {
      return { manifest: cache.manifest, fromCache: true, cachedAt: cache.cachedAt };
    }
    if (!res.ok) throw new Error(`registry fetch failed: HTTP ${res.status}`);

    const manifest = spec.parse((await res.json()) as unknown);
    const env: CacheEnvelope<M> = {
      etag: res.headers.get("etag") ?? undefined,
      cachedAt: new Date().toISOString(),
      manifest,
    };
    writeCacheFile(spec.file, env);
    return { manifest, fromCache: false, cachedAt: env.cachedAt };
  } catch (err) {
    if (cache) {
      return {
        manifest: cache.manifest,
        fromCache: true,
        cachedAt: cache.cachedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      manifest: spec.empty,
      fromCache: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Background conditional GET that refreshes the cache without blocking a read. */
async function revalidateGeneric<M>(spec: FetchSpec<M>, cache: CacheEnvelope<M>): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(spec.url, {
        signal: controller.signal,
        headers: cache.etag ? { "If-None-Match": cache.etag } : {},
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 304 || !res.ok) return;
    const manifest = spec.parse((await res.json()) as unknown);
    writeCacheFile(spec.file, {
      etag: res.headers.get("etag") ?? undefined,
      cachedAt: new Date().toISOString(),
      manifest,
    });
  } catch {
    /* silent — the cached copy remains valid */
  }
}

// ── tools/commands manifest ─────────────────────────────────────────────────

const MANIFEST_SPEC: FetchSpec<CommunityManifest> = {
  url: MANIFEST_URL,
  file: CACHE_FILE,
  parse: parseManifest,
  empty: { version: 1, updatedAt: "", mcpServers: [], services: [], commands: [] },
};

/**
 * Fetch the registry manifest.
 *
 * @param opts.force  Skip the conditional-GET short-circuit and the "serve cache
 *                    first" path — always hit the network (still falls back to
 *                    cache on failure). Used by an explicit "Refresh".
 */
export function fetchManifest(opts?: { force?: boolean }): Promise<RegistryFetchResult> {
  return fetchGeneric(MANIFEST_SPEC, opts);
}

/** Force a network refresh (bypasses cache-first). Used by an explicit Refresh. */
export function refreshManifest(): Promise<RegistryFetchResult> {
  return fetchManifest({ force: true });
}

// ── providers manifest ──────────────────────────────────────────────────────

const PROVIDERS_SPEC: FetchSpec<ProvidersManifest> = {
  url: PROVIDERS_URL,
  file: PROVIDERS_CACHE_FILE,
  parse: parseProvidersManifest,
  empty: { version: 1, updatedAt: "", providers: [] },
};

/** Fetch the community PROVIDERS manifest (cache-first; see fetchManifest). */
export function fetchProvidersManifest(opts?: { force?: boolean }): Promise<ProvidersFetchResult> {
  return fetchGeneric(PROVIDERS_SPEC, opts);
}

/** Force a network refresh of the providers manifest. */
export function refreshProvidersManifest(): Promise<ProvidersFetchResult> {
  return fetchProvidersManifest({ force: true });
}

/** Exposed for tests. */
export const __test = {
  MANIFEST_URL,
  PROVIDERS_URL,
  CACHE_FILE,
  PROVIDERS_CACHE_FILE,
  cachePath: () => cacheFilePath(CACHE_FILE),
  readCache: () => readCacheFile(CACHE_FILE, parseManifest),
  writeCache: (env: CacheEnvelope<CommunityManifest>) => writeCacheFile(CACHE_FILE, env),
};
