/**
 * Tool toggles — device-global on/off switches for INSTALLED community services.
 * Stored in the meta DB (getMeta/setMeta), so a toggle applies across EVERY
 * workspace/project on this device and is never synced.
 *
 * Scope: only installed HTTP-service (and, later, MCP) tools are toggleable.
 * Built-in Cairn tools are ALWAYS on and are never written here — they are the
 * assistant itself, and this matches desktop, where gating only applies to
 * external MCP servers / HTTP services (see electron/lib/external-tools.ts),
 * never Cairn's own tools. The Settings screen therefore lists built-ins
 * read-only and only puts switches on installed services.
 *
 * The enabled set gates what `allTools()` / `allToolMap()` expose for installed
 * services, which keeps the PCC 32K context lean and lets a user silence a
 * service they don't want the assistant to reach for.
 */

import { getMeta, setMeta } from "../db";

const META_KEY = "tools.enabled"; // JSON: { [toolName: string]: boolean }

function readMap(): Record<string, boolean> {
  const raw = getMeta(META_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, boolean>): void {
  setMeta(META_KEY, JSON.stringify(map));
}

/**
 * Whether a tool is enabled. Tools default to ENABLED — a tool is only off when
 * an explicit `false` has been written for it, so newly-added built-ins and
 * freshly-installed services are on until the user turns them off.
 */
export function isToolEnabled(name: string): boolean {
  const map = readMap();
  return map[name] !== false;
}

/** Set a tool's enabled state (persists to the device-global meta DB). */
export function setToolEnabled(name: string, enabled: boolean): void {
  const map = readMap();
  map[name] = enabled;
  writeMap(map);
}

/** The full enabled map (explicit entries only; missing = default-on). */
export function getToggleMap(): Record<string, boolean> {
  return readMap();
}

/** Drop a tool's toggle entry entirely (used when a service is uninstalled). */
export function clearToolToggle(name: string): void {
  const map = readMap();
  if (name in map) {
    delete map[name];
    writeMap(map);
  }
}
