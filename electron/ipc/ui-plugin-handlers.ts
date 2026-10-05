/**
 * UI-plugin IPC (§ plugin-UI). A UI plugin's code runs in the RENDERER, but the
 * manifest + files live under <userData>/plugins read by MAIN. This bridges the
 * two: `plugins:listUi` returns each enabled ui-entry's { id, source } (the raw
 * module text), and `plugins:ui-changed` fires when the plugins dir changes so
 * the renderer can re-pull + re-activate. Dev-gated (CAIRN_PLUGINS_DEV=1).
 *
 * Security note: the renderer evaluates this source (new Function). That is a
 * code-exec surface — acceptable ONLY behind the dev flag; untrusted-plugin
 * sandboxing is Tier 3 (see docs/plans §10.8 / plugin architecture note).
 *
 * Channels are typed by `shared/ipc/contract.ts` and wrapped in the shared
 * handle(), so failures (including the dev-flag gate) throw and reach the
 * renderer as rejections.
 */
import * as fs from "fs";
import * as path from "path";
import { shell, type WebContents } from "electron";
import * as yaml from "js-yaml";
import { readEnabledManifest, pluginsDevEnabled } from "../cordis/plugin-loader";
import { getAgentHost } from "../cordis/agent-host";
import { registerContractHandle, sendIpcEvent } from "./registry";
import { handle } from "./result-helpers";
import type { PluginEntry, UiPluginSource } from "../../shared/types/plugins";
// NOTE: readEnabledManifest/pluginsDevEnabled stay direct imports by design —
// this dev-gated UI surface does main-side file IO (plugins.yml YAML,
// fs watcher) that stays in main even after a host-process split. Only the
// configured root round-trips through AgentHost (configure/getPluginsRoot).

export type UiPluginPayload = UiPluginSource;

function collectUiPlugins(): UiPluginPayload[] {
  if (!pluginsDevEnabled()) return [];
  const root = getAgentHost().getPluginsRoot();
  if (!root) return [];
  const out: UiPluginPayload[] = [];
  for (const e of readEnabledManifest()) {
    if (!e.ui) continue;
    try {
      const file = path.resolve(root, e.ui);
      // Contain to the plugins dir — sep-aware (prevents sibling escape /plugins-evil).
      const resolvedRoot = path.resolve(root);
      if (file !== resolvedRoot && !file.startsWith(resolvedRoot + path.sep)) {
        console.error(`[cairn-plugins] ui path escapes plugins dir, skipping: ${e.ui}`);
        continue;
      }
      out.push({ id: e.id, source: fs.readFileSync(file, "utf8") });
    } catch (err) {
      console.error(`[cairn-plugins] failed to read ui plugin '${e.id}' (${e.ui}):`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

let watcher: fs.FSWatcher | null = null;
let debounce: NodeJS.Timeout | null = null;

export function registerUiPluginHandlers(getWebContents: () => WebContents | undefined): void {
  registerContractHandle("plugins:listUi", () => handle(() => collectUiPlugins()));

  // ── Plugins settings section: list all entries (enabled + disabled), toggle,
  // open the folder. Reads/writes plugins.yml as a plain YAML array.
  const MANIFEST = "plugins.yml";
  const manifestPath = () => path.join(getAgentHost().getPluginsRoot(), MANIFEST);

  function readAllRows(): Array<Record<string, unknown>> {
    const root = getAgentHost().getPluginsRoot();
    if (!root) return [];
    try {
      const parsed = yaml.load(fs.readFileSync(manifestPath(), "utf8"), { schema: yaml.DEFAULT_SCHEMA });
      return Array.isArray(parsed) ? (parsed.filter((r) => r && typeof r === "object" && !Array.isArray(r)) as Array<Record<string, unknown>>) : [];
    } catch {
      return [];
    }
  }

  const DEV_GATE = "Plugins are in developer preview — launch with CAIRN_PLUGINS_DEV=1";
  const requireRoot = (action: string): string => {
    if (!pluginsDevEnabled()) throw new Error(`${DEV_GATE} to ${action}.`);
    const root = getAgentHost().getPluginsRoot();
    if (!root) throw new Error("no plugins directory configured");
    return root;
  };

  // In prod the list is still returned (the settings UI reads it); devEnabled
  // lets the renderer hide the enable/install controls.
  registerContractHandle("plugins:list", () => handle(() => {
    const plugins: PluginEntry[] = readAllRows()
      .filter((r) => typeof r.id === "string")
      .map((r) => ({
        id: r.id as string,
        kind: typeof r.ui === "string" && typeof r.name === "string" ? "both"
          : typeof r.ui === "string" ? "ui"
          : "backend",
        name: (r.name as string) ?? null,
        ui: (r.ui as string) ?? null,
        source: typeof r.source === "string" ? r.source : null,
        disabled: r.disabled === true,
      }));
    return { devEnabled: pluginsDevEnabled(), root: getAgentHost().getPluginsRoot(), plugins };
  }));

  registerContractHandle("plugins:setEnabled", (_e, req) => handle(() => {
    requireRoot("toggle plugins");
    const rows = readAllRows();
    const row = rows.find((r) => r.id === req.id);
    if (!row) throw new Error(`plugin '${req.id}' not found in ${MANIFEST}`);
    if (req.enabled) delete row.disabled;
    else row.disabled = true;
    // Re-dump the whole array (plain data; comments in the file are not
    // preserved — acceptable for a managed manifest). The plugin-dir watcher
    // (both backend loader + this module) reconciles live; the renderer
    // re-pulls on plugins:ui-changed.
    fs.writeFileSync(manifestPath(), yaml.dump(rows, { lineWidth: 100 }));
    return { ok: true as const };
  }));

  registerContractHandle("plugins:openFolder", () => handle(async () => {
    const root = requireRoot("open the plugins folder");
    fs.mkdirSync(root, { recursive: true });
    await shell.openPath(root);
    return { ok: true as const };
  }));

  // ── Install / uninstall (C2, §20). Fetching + running third-party code is a
  // code-exec surface, so install is only permitted under the dev flag until the
  // Tier-3 sandbox exists. The plugin-dir watcher reconciles the new entry live.
  registerContractHandle("plugins:install", (_e, req) => handle(() => {
    if (!pluginsDevEnabled()) throw new Error(`${DEV_GATE} to install.`);
    if (!req || typeof req.spec !== "string" || !req.spec.trim()) {
      throw new Error("provide a plugin spec (github:owner/repo or a local path)");
    }
    return getAgentHost().installPlugin(req.spec);
  }));

  registerContractHandle("plugins:uninstall", (_e, req) => handle(() => {
    if (!pluginsDevEnabled()) throw new Error(`${DEV_GATE} to uninstall.`);
    if (!req || typeof req.id !== "string") throw new Error("missing plugin id");
    getAgentHost().uninstallPlugin(req.id);
    return { ok: true as const };
  }));

  // Update: re-run an installed plugin's recorded source spec (re-fetch github /
  // re-copy local) to pull the latest build. Dev-gated like install.
  registerContractHandle("plugins:update", (_e, req) => handle(() => {
    if (!pluginsDevEnabled()) throw new Error(`${DEV_GATE} to update.`);
    if (!req || typeof req.id !== "string") throw new Error("missing plugin id");
    return getAgentHost().updatePlugin(req.id);
  }));

  if (!pluginsDevEnabled()) return;
  const root = getAgentHost().getPluginsRoot();
  if (!root || watcher) return;
  try {
    fs.mkdirSync(root, { recursive: true });
    watcher = fs.watch(root, { persistent: false }, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const wc = getWebContents();
        if (wc && !wc.isDestroyed()) sendIpcEvent(wc, "plugins:ui-changed");
      }, 200);
    });
  } catch (err) {
    console.error("[cairn-plugins] ui watcher failed:", err instanceof Error ? err.message : err);
  }
}
