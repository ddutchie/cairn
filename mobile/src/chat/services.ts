/**
 * Installed HTTP services — the mobile side of the community registry's
 * `service` connectors (Track 2). An installed service is a stored HTTP call
 * definition that the chat agent can invoke as a namespaced tool.
 *
  * Storage split (non-secret config in the meta DB, secrets in the keychain):
 *   - The non-secret definition lives in the DEVICE-GLOBAL meta DB
 *     (getMeta/setMeta) as a JSON array — local-only, never synced, so an
 *     installed service is available in EVERY workspace/project on this device.
 *   - The API key (secret) lives in expo-secure-store under `svc.<id>.apiKey`,
 *     never in SQLite and never synced.
 *
 * Pure request-shaping is reused wholesale from @cairn/shared/chat/service-exec
 * (the SAME core the desktop custom-services.ts uses). This module only adds the
 * platform I/O: expo/fetch + secure-store secret resolution + the meta-DB store.
 *
 * Track 2 supports authMode:"none" services only (an API-key header). OAuth
 * services (authMode:"oauth") are deferred to Track 3 — install() rejects them.
 */

import { fetch as expoFetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";
import {
  serviceOperationsToOpenAI,
  resolveOperation,
  buildOperationRequest,
  filterResponse,
  parseToolDefinition,
  type CustomServiceRuntimeConfig,
} from "@cairn/shared/chat/service-exec";
import type { RegistryServiceEntry } from "@cairn/shared/chat/registry-schema";
import { getMeta, setMeta } from "../db";
import { clearToolToggle } from "./tool-toggles";
import type { ToolDef } from "./tools";

const META_INSTALLED = "services.installed"; // JSON array of InstalledService

/** Request timeout for a service call (ms). Keeps a hung endpoint from stalling chat. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * A service the user has installed. This is the registry entry's `definition`
 * plus the registry `id`/`name` for display. Secrets are NOT stored here.
 */
export interface InstalledService {
  id: string; // registry entry id (namespacing key)
  name: string; // display name
  blurb?: string;
  iconSvg?: string; // brand logo markup (registry, CI-sanitized) for ConnectorLogo
  brandColor?: string;
  definition: RegistryServiceEntry["definition"];
}

const secureKey = (id: string) => `svc.${id}.apiKey`;

// ── install store (meta DB) ───────────────────────────────────────────────────

/** All installed services (device-global). */
export function listInstalledServices(): InstalledService[] {
  const raw = getMeta(META_INSTALLED);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as InstalledService[]) : [];
  } catch {
    return [];
  }
}

function writeInstalled(list: InstalledService[]): void {
  setMeta(META_INSTALLED, JSON.stringify(list));
}

/** Whether a registry service id is installed. */
export function isServiceInstalled(id: string): boolean {
  return listInstalledServices().some((s) => s.id === id);
}

/**
 * Install a registry `service` entry, storing its API key in the keychain.
 * Track 2 only supports authMode:"none" (API-key header) — an oauth service is
 * rejected here (Track 3). Passing an empty apiKey is allowed for services whose
 * definition needs no key (authMode:none + no <API_KEY> header placeholder).
 */
export async function installService(entry: RegistryServiceEntry, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  if (entry.definition.authMode === "oauth") {
    return { ok: false, error: "OAuth services aren't supported on mobile yet." };
  }
  const key = apiKey.trim();
  if (key) {
    try {
      await SecureStore.setItemAsync(secureKey(entry.id), key);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const record: InstalledService = {
    id: entry.id,
    name: entry.definition.name || entry.id,
    blurb: entry.blurb,
    iconSvg: entry.iconSvg,
    brandColor: entry.brandColor,
    definition: entry.definition,
  };
  const list = listInstalledServices().filter((s) => s.id !== entry.id);
  list.push(record);
  writeInstalled(list);
  return { ok: true };
}

/** Uninstall a service: drop its record, secret, and any toggle entries. */
export async function uninstallService(id: string): Promise<void> {
  const list = listInstalledServices();
  const svc = list.find((s) => s.id === id);
  writeInstalled(list.filter((s) => s.id !== id));
  await SecureStore.deleteItemAsync(secureKey(id)).catch(() => {});
  // Remove the toggle for EVERY operation's namespaced tool so a reinstall
  // starts default-on (a multi-op service has one tool per operation).
  if (svc) {
    try {
      for (const def of serviceOperationsToOpenAI(toRuntimeConfig(svc))) {
        clearToolToggle(def.function.name);
      }
    } catch {
      /* best-effort */
    }
  }
}

/** Read a service's stored API key (null if none). */
function getServiceApiKey(id: string): Promise<string | null> {
  return SecureStore.getItemAsync(secureKey(id)).catch(() => null);
}

// ── runtime: turn installed services into ToolDefs ────────────────────────────

/** Map an InstalledService's definition to the shared runtime config. */
function toRuntimeConfig(svc: InstalledService): CustomServiceRuntimeConfig {
  const d = svc.definition;
  return {
    id: svc.id,
    // Legacy single-op fields (may be undefined for multi-op services).
    apiUrl: d.apiUrl,
    method: d.method,
    toolDefinition: d.toolDefinition,
    responseKeys: d.responseKeys,
    // Multi-op fields.
    baseUrl: d.baseUrl,
    operations: d.operations,
    headers: d.headers,
    authMode: d.authMode,
  };
}

/**
 * Resolve a service's header template into concrete headers, substituting the
 * `<API_KEY>` placeholder with the stored secret. A header whose placeholder is
 * unfilled (no key stored) is DROPPED rather than sent verbatim — mirrors the
 * desktop resolveSecrets contract so a raw "<API_KEY>" never reaches the wire.
 */
async function resolveHeaders(svc: InstalledService): Promise<Record<string, string>> {
  const template = svc.definition.headers ?? {};
  const apiKey = await getServiceApiKey(svc.id);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(template)) {
    if (value.includes("<API_KEY>")) {
      if (apiKey) out[name] = value.replaceAll("<API_KEY>", apiKey);
      // else: drop the header (missing secret)
    } else {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Execute one OPERATION of an installed service (by its namespaced tool name).
 * Uses the shared operation resolver + request-shaping (resolveOperation +
 * buildOperationRequest) + response filtering; adds only expo/fetch + secret
 * resolution. Returns a plain object the agent serialises. Never throws.
 */
async function runService(svc: InstalledService, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const cfg = toRuntimeConfig(svc);
  const op = resolveOperation(cfg, toolName);
  if (!op) return { error: `Unknown operation ${toolName} for ${svc.name}.` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // parseToolDefinition can throw on a malformed toolDefinition — keep it in
    // the try so it resolves to the standard { error } path, never a throw.
    const parameters = parseToolDefinition(op.toolDefinition).parameters;
    const headers = await resolveHeaders(svc);
    const { url, init } = buildOperationRequest(op, args, headers, parameters);
    const res = await expoFetch(url, {
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? init.body : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      return { error: `${svc.name} failed (${res.status}).` };
    }
    const contentType = res.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await res.json() : await res.text();
    return filterResponse(body, op.responseKeys);
  } catch (e) {
    if (controller.signal.aborted) return { error: `${svc.name} timed out.` };
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The installed services as mobile ToolDefs — ONE per operation, ready to fold
 * into TOOLS. Each tool name is namespaced (`svc__<serviceId>__<opName>`) via the
 * shared helper so it can't collide with a built-in or another service's tools.
 */
export function serviceToolDefs(): ToolDef[] {
  const out: ToolDef[] = [];
  for (const svc of listInstalledServices()) {
    const cfg = toRuntimeConfig(svc);
    for (const def of serviceOperationsToOpenAI(cfg)) {
      const toolName = def.function.name;
      out.push({
        name: toolName,
        description: def.function.description,
        params: JSON.stringify(def.function.parameters),
        jsonSchema: def.function.parameters,
        run: (args: Record<string, unknown>) => runService(svc, toolName, args),
      });
    }
  }
  return out;
}

/**
 * The namespaced tool defs (name + description) for ONE installed service — used
 * by the Settings screen to list a service's operations with per-tool toggles.
 */
export function serviceOperationDefs(svc: InstalledService): { name: string; description: string }[] {
  return serviceOperationsToOpenAI(toRuntimeConfig(svc)).map((d) => ({
    name: d.function.name,
    description: d.function.description,
  }));
}
