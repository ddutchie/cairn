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
  id: string;
  author: string;
  version: string;
  category?: string;
  tags: string[];
  blurb: string;
  brandColor?: string;
  homepage?: string;
  /** Brand logo, compiled + allowlist-sanitized by cairn-community CI. */
  iconSvg?: string;
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
  apiKeyUrl: z.string().url().startsWith("https://").optional(),
  enabled: z.boolean(),
});

const entryMeta = {
  id: z.string(),
  author: z.string(),
  version: z.string(),
  category: z.string().optional(),
  tags: z.array(z.string()),
  blurb: z.string(),
  brandColor: z.string().optional(),
  // Validated as an https URL — it is rendered as an anchor href in the Browse
  // modal, so an unvalidated string could smuggle a javascript:/data: URI.
  homepage: z.string().url().startsWith("https://").optional(),
  // Brand logo, compiled + allowlist-sanitized by cairn-community CI (never raw
  // user SVG). Rendered inline by ConnectorLogo. Absent → app fallback glyph.
  iconSvg: z.string().optional(),
};

const mcpEntry = z.object({ ...entryMeta, definition: mcpDefinition }).passthrough();
const serviceEntry = z.object({ ...entryMeta, definition: serviceDefinition }).passthrough();

// Manifest-level shape only validates the envelope; entries are validated
// individually in parseManifest so ONE bad community entry can't blank the
// whole catalog (the reject-all behaviour of z.array(z.object(...)) would).
const manifestSchema = z.object({
  version: z.number(),
  updatedAt: z.string(),
  mcpServers: z.array(z.unknown()),
  services: z.array(z.unknown()),
});

/** Parse + validate an unknown payload into a CommunityManifest, or throw. */
export function parseManifest(raw: unknown): CommunityManifest {
  const m = manifestSchema.parse(raw);
  return {
    version: m.version,
    updatedAt: m.updatedAt,
    // Drop malformed entries individually rather than failing the whole parse.
    mcpServers: m.mcpServers.flatMap((e) => {
      const r = mcpEntry.safeParse(e);
      return r.success ? [r.data] : [];
    }),
    services: m.services.flatMap((e) => {
      const r = serviceEntry.safeParse(e);
      return r.success ? [r.data] : [];
    }),
  } as CommunityManifest;
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
