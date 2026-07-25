/**
 * Installed MCP servers — the mobile side of the community registry's `mcp`
 * connectors (Track 3). Parallel to services.ts, but for streamable-HTTP MCP
 * servers instead of single HTTP calls.
 *
 * Storage split (device-global, unsynced):
 *   - The server config lives in the meta DB (getMeta/setMeta) as JSON.
 *   - A CACHE of each server's discovered tool defs (namespaced OpenAI defs) also
 *     lives in meta, so the model-facing tool list (allTools/toolsForAgent) stays
 *     SYNCHRONOUS. Discovery is a network call; we refresh the cache at connect /
 *     Settings-open time and read it synchronously when assembling tools. A tool
 *     absent from the cache simply isn't offered until the next refresh.
 *   - OAuth artefacts + API-key headers live in expo-secure-store (see mcp-oauth
 *     + per-server header resolution), never here.
 */

import { getMeta, setMeta } from "../db";
import type { RegistryMcpEntry } from "@cairn/shared/chat/registry-schema";
import type { OpenAIToolDef } from "@cairn/shared/chat/mcp-namespace";
import type { McpServerRuntimeConfig } from "./mcp-client";
import * as mcpClient from "./mcp-client";
import { signOut } from "./mcp-oauth";

const META_INSTALLED = "mcp.installed"; // JSON array of InstalledMcpServer
const META_TOOLCACHE = "mcp.toolcache"; // JSON map serverId -> OpenAIToolDef[]

/** An installed MCP server: registry id/name + the connection-relevant config. */
export interface InstalledMcpServer {
  id: string;
  name: string;
  blurb?: string;
  iconSvg?: string; // brand logo markup (registry, CI-sanitized) for ConnectorLogo
  brandColor?: string;
  baseUrl: string;
  transport: "http" | "sse";
  authMode: "none" | "oauth";
  oauthScope?: string;
  /** Static headers (e.g. API-key servers). May contain <API_KEY> placeholders. */
  headers?: Record<string, string>;
}

// ── install store (meta DB) ───────────────────────────────────────────────────

export function listInstalledMcpServers(): InstalledMcpServer[] {
  const raw = getMeta(META_INSTALLED);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as InstalledMcpServer[]) : [];
  } catch {
    return [];
  }
}

function writeInstalled(list: InstalledMcpServer[]): void {
  setMeta(META_INSTALLED, JSON.stringify(list));
}

export function isMcpServerInstalled(id: string): boolean {
  return listInstalledMcpServers().some((s) => s.id === id);
}

export function getInstalledMcpServer(id: string): InstalledMcpServer | undefined {
  return listInstalledMcpServers().find((s) => s.id === id);
}

/** Install (or overwrite) a registry MCP entry. Does NOT connect or authorize. */
export function installMcpServer(entry: RegistryMcpEntry): void {
  const d = entry.definition;
  const record: InstalledMcpServer = {
    id: entry.id,
    name: d.name || entry.id,
    blurb: entry.blurb,
    iconSvg: entry.iconSvg,
    brandColor: entry.brandColor,
    baseUrl: d.baseUrl,
    transport: d.transport,
    authMode: d.authMode ?? "none",
    oauthScope: d.oauthScope,
    headers: d.headers,
  };
  const list = listInstalledMcpServers().filter((s) => s.id !== entry.id);
  list.push(record);
  writeInstalled(list);
}

/** Uninstall a server: drop record, cached tools, OAuth artefacts, live conn. */
export async function uninstallMcpServer(id: string): Promise<void> {
  writeInstalled(listInstalledMcpServers().filter((s) => s.id !== id));
  clearCachedTools(id);
  await signOut(id).catch(() => {});
  await mcpClient.dispose(id).catch(() => {});
}

/** Map an installed server to the client runtime config. */
export function toRuntimeConfig(s: InstalledMcpServer): McpServerRuntimeConfig {
  return {
    id: s.id,
    baseUrl: s.baseUrl,
    transport: s.transport,
    headers: s.headers,
    authMode: s.authMode,
    oauthScope: s.oauthScope,
    name: s.name,
  };
}

// ── discovered-tool cache (meta DB) ───────────────────────────────────────────

function readCache(): Record<string, OpenAIToolDef[]> {
  const raw = getMeta(META_TOOLCACHE);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, OpenAIToolDef[]>) : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, OpenAIToolDef[]>): void {
  setMeta(META_TOOLCACHE, JSON.stringify(cache));
}

/** Cached namespaced tool defs for ALL installed servers (sync — for the model). */
export function getCachedMcpToolDefs(): OpenAIToolDef[] {
  const cache = readCache();
  const installed = new Set(listInstalledMcpServers().map((s) => s.id));
  const out: OpenAIToolDef[] = [];
  for (const [serverId, defs] of Object.entries(cache)) {
    if (installed.has(serverId)) out.push(...defs);
  }
  return out;
}

/** Cached namespaced tool defs for ONE server (for the per-server tool list). */
export function getCachedMcpToolDefsForServer(serverId: string): OpenAIToolDef[] {
  return readCache()[serverId] ?? [];
}

function clearCachedTools(serverId: string): void {
  const cache = readCache();
  if (serverId in cache) {
    delete cache[serverId];
    writeCache(cache);
  }
}

/**
 * Refresh (connect + listTools) the discovered-tool cache for one server. Called
 * after connect/sign-in and when the Settings screen opens. Returns the count,
 * or null on failure (cache left as-is). Never throws.
 */
export async function refreshServerTools(id: string): Promise<number | null> {
  const server = getInstalledMcpServer(id);
  if (!server) return null;
  const defs = await mcpClient.listTools(toRuntimeConfig(server));
  // listTools returns [] both for "no tools" and "connection failed"; only
  // overwrite the cache when we actually got tools, so a transient failure
  // doesn't wipe a previously-good list.
  if (defs.length === 0) return null;
  const cache = readCache();
  cache[id] = defs;
  writeCache(cache);
  return defs.length;
}

/** Refresh every installed server's tool cache (best-effort, parallel). */
export async function refreshAllServerTools(): Promise<void> {
  await Promise.all(listInstalledMcpServers().map((s) => refreshServerTools(s.id).catch(() => null)));
}
