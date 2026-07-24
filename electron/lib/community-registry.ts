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
import * as z from "zod";
import { findUserDataDir } from "../runtime/port-discovery";

// Local types (main-process side mirrors src/types/index.ts — the two sides are
// wired by IPC channel strings, not a shared import; see preload.ts convention).
export interface CommunityManifest {
  version: number;
  updatedAt: string;
  mcpServers: RegistryMcpEntry[];
  services: RegistryServiceEntry[];
}
interface RegistryEntryMeta {
  author: string;
  version: string;
  tags: string[];
  blurb: string;
  logo?: string;
  brandColor?: string;
  homepage?: string;
}
interface RegistryMcpEntry extends RegistryEntryMeta {
  definition: {
    name: string;
    description?: string;
    transport: "sse" | "http";
    baseUrl: string;
    headers?: Record<string, string>;
    authMode?: "none" | "oauth";
    oauthScope?: string;
    disabledTools?: string[];
    enabled: boolean;
  };
}
interface RegistryServiceEntry extends RegistryEntryMeta {
  definition: {
    name: string;
    description?: string;
    apiUrl: string;
    method: "GET" | "POST" | "PUT" | "DELETE";
    headers?: Record<string, string>;
    toolDefinition: string;
    responseKeys?: string[];
    apiKeyUrl?: string;
    enabled: boolean;
  };
}
export interface RegistryFetchResult {
  manifest: CommunityManifest;
  fromCache: boolean;
  cachedAt?: string;
  error?: string;
}

const MANIFEST_URL =
  "https://raw.githubusercontent.com/ddutchie/cairn-community/main/manifest.json";
const CACHE_FILE = "community-registry.json";
const FETCH_TIMEOUT_MS = 10_000;

// ── validation (mirrors cairn-community/schema.json) ────────────────────────

const headers = z.record(z.string(), z.string()).optional();

const mcpDefinition = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  transport: z.enum(["sse", "http"]),
  baseUrl: z.string().url().startsWith("https://"),
  headers,
  authMode: z.enum(["none", "oauth"]).optional(),
  oauthScope: z.string().optional(),
  disabledTools: z.array(z.string()).optional(),
  enabled: z.boolean(),
});

const serviceDefinition = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  apiUrl: z.string().url().startsWith("https://"),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  headers,
  toolDefinition: z.string().min(1),
  responseKeys: z.array(z.string()).optional(),
  apiKeyUrl: z.string().optional(),
  enabled: z.boolean(),
});

const entryMeta = {
  author: z.string(),
  version: z.string(),
  tags: z.array(z.string()),
  blurb: z.string(),
  logo: z.string().optional(),
  brandColor: z.string().optional(),
  homepage: z.string().optional(),
};

const manifestSchema = z.object({
  version: z.number(),
  updatedAt: z.string(),
  // Drop individual malformed entries rather than reject the whole manifest, so
  // one bad community PR can't blank the catalog for everyone.
  mcpServers: z.array(z.object({ ...entryMeta, definition: mcpDefinition }).passthrough()),
  services: z.array(z.object({ ...entryMeta, definition: serviceDefinition }).passthrough()),
});

/** Parse + validate an unknown payload into a CommunityManifest, or throw. */
export function parseManifest(raw: unknown): CommunityManifest {
  return manifestSchema.parse(raw) as CommunityManifest;
}

// ── cache ───────────────────────────────────────────────────────────────────

interface CacheEnvelope {
  etag?: string;
  cachedAt: string;
  manifest: CommunityManifest;
}

function cachePath(): string | null {
  const dir = findUserDataDir();
  return dir ? path.join(dir, CACHE_FILE) : null;
}

function readCache(): CacheEnvelope | null {
  const p = cachePath();
  if (!p || !fs.existsSync(p)) return null;
  try {
    const env = JSON.parse(fs.readFileSync(p, "utf8")) as CacheEnvelope;
    // Re-validate the cached manifest so a corrupted/older-shape file can't feed
    // an invalid manifest downstream.
    env.manifest = parseManifest(env.manifest);
    return env;
  } catch {
    return null;
  }
}

function writeCache(env: CacheEnvelope): void {
  const p = cachePath();
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

// ── fetch ─────────────────────────────────────────────────────────────────

/**
 * Fetch the registry manifest.
 *
 * @param opts.force  Skip the conditional-GET short-circuit and the "serve cache
 *                    first" path — always hit the network (still falls back to
 *                    cache on failure). Used by an explicit "Refresh".
 */
export async function fetchManifest(opts?: { force?: boolean }): Promise<RegistryFetchResult> {
  const cache = readCache();

  // Cache-first (non-forced): serve the cache immediately when present. Callers
  // wanting freshness pass force:true. This keeps the browse UI instant/offline.
  if (cache && !opts?.force) {
    // Kick a background revalidation but don't await it — return cache now.
    void revalidate(cache);
    return { manifest: cache.manifest, fromCache: true, cachedAt: cache.cachedAt };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(MANIFEST_URL, {
        signal: controller.signal,
        headers: cache?.etag ? { "If-None-Match": cache.etag } : {},
      });
    } finally {
      clearTimeout(timer);
    }

    // 304 Not Modified → our cache is current.
    if (res.status === 304 && cache) {
      return { manifest: cache.manifest, fromCache: true, cachedAt: cache.cachedAt };
    }
    if (!res.ok) throw new Error(`registry fetch failed: HTTP ${res.status}`);

    const json = (await res.json()) as unknown;
    const manifest = parseManifest(json);
    const env: CacheEnvelope = {
      etag: res.headers.get("etag") ?? undefined,
      cachedAt: new Date().toISOString(),
      manifest,
    };
    writeCache(env);
    return { manifest, fromCache: false, cachedAt: env.cachedAt };
  } catch (err) {
    // Network/parse failure → serve stale cache if we have one.
    if (cache) {
      return {
        manifest: cache.manifest,
        fromCache: true,
        cachedAt: cache.cachedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      manifest: { version: 1, updatedAt: "", mcpServers: [], services: [] },
      fromCache: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Background conditional GET that refreshes the cache without blocking a read. */
async function revalidate(cache: CacheEnvelope): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(MANIFEST_URL, {
        signal: controller.signal,
        headers: cache.etag ? { "If-None-Match": cache.etag } : {},
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 304 || !res.ok) return;
    const manifest = parseManifest((await res.json()) as unknown);
    writeCache({
      etag: res.headers.get("etag") ?? undefined,
      cachedAt: new Date().toISOString(),
      manifest,
    });
  } catch {
    /* silent — the cached copy remains valid */
  }
}

/** Force a network refresh (bypasses cache-first). Used by an explicit Refresh. */
export function refreshManifest(): Promise<RegistryFetchResult> {
  return fetchManifest({ force: true });
}

/** Exposed for tests. */
export const __test = { MANIFEST_URL, CACHE_FILE, cachePath, readCache, writeCache };
