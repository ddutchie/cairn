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
 */
import * as fs from "fs";
import * as path from "path";
import { ipcMain, shell, type WebContents } from "electron";
import * as yaml from "js-yaml";
import { readEnabledManifest, getPluginsRoot, pluginsDevEnabled } from "../cordis/plugin-loader";
import { installPlugin, uninstallPlugin } from "../cordis/plugin-installer";

export interface UiPluginPayload {
  id: string;
  source: string;
}

function collectUiPlugins(): UiPluginPayload[] {
  if (!pluginsDevEnabled()) return [];
  const root = getPluginsRoot();
  if (!root) return [];
  const out: UiPluginPayload[] = [];
  for (const e of readEnabledManifest()) {
    if (!e.ui) continue;
    try {
      const file = path.resolve(root, e.ui);
      // Contain to the plugins dir.
      if (!file.startsWith(path.resolve(root))) {
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
  ipcMain.handle("plugins:listUi", () => {
    try {
      return { data: collectUiPlugins() };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Plugins settings section: list all entries (enabled + disabled), toggle,
  // open the folder. Reads/writes plugins.yml as a plain YAML array.
  const MANIFEST = "plugins.yml";
  const manifestPath = () => path.join(getPluginsRoot(), MANIFEST);

  function readAllRows(): Array<Record<string, unknown>> {
    const root = getPluginsRoot();
    if (!root) return [];
    try {
      const parsed = yaml.load(fs.readFileSync(manifestPath(), "utf8"), { schema: yaml.DEFAULT_SCHEMA });
      return Array.isArray(parsed) ? (parsed.filter((r) => r && typeof r === "object" && !Array.isArray(r)) as Array<Record<string, unknown>>) : [];
    } catch {
      return [];
    }
  }

  ipcMain.handle("plugins:list", () => {
    try {
      const rows = readAllRows();
      const list = rows
        .filter((r) => typeof r.id === "string")
        .map((r) => ({
          id: r.id as string,
          kind: typeof r.ui === "string" && typeof r.name === "string" ? "both"
            : typeof r.ui === "string" ? "ui"
            : "backend",
          name: (r.name as string) ?? null,
          ui: (r.ui as string) ?? null,
          disabled: r.disabled === true,
        }));
      return { data: { devEnabled: pluginsDevEnabled(), root: getPluginsRoot(), plugins: list } };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("plugins:setEnabled", (_e, req: { id: string; enabled: boolean }) => {
    try {
      const root = getPluginsRoot();
      if (!root) return { error: "no plugins directory configured" };
      const rows = readAllRows();
      const row = rows.find((r) => r.id === req.id);
      if (!row) return { error: `plugin '${req.id}' not found in ${MANIFEST}` };
      if (req.enabled) delete row.disabled;
      else row.disabled = true;
      // Re-dump the whole array (plain data; comments in the file are not
      // preserved — acceptable for a managed manifest).
      fs.writeFileSync(manifestPath(), yaml.dump(rows, { lineWidth: 100 }));
      // The plugin-dir watcher (both backend loader + this module) will fire and
      // reconcile live; the renderer re-pulls on plugins:ui-changed.
      return { data: { ok: true } };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("plugins:openFolder", async () => {
    try {
      const root = getPluginsRoot();
      if (!root) return { error: "no plugins directory configured" };
      fs.mkdirSync(root, { recursive: true });
      await shell.openPath(root);
      return { data: { ok: true } };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Install / uninstall (C2, §20). Fetching + running third-party code is a
  // code-exec surface, so install is only permitted under the dev flag until the
  // Tier-3 sandbox exists. The plugin-dir watcher reconciles the new entry live.
  ipcMain.handle("plugins:install", async (_e, req: { spec: string }) => {
    try {
      if (!pluginsDevEnabled()) {
        return { error: "Plugins are in developer preview — launch with CAIRN_PLUGINS_DEV=1 to install." };
      }
      if (!req || typeof req.spec !== "string" || !req.spec.trim()) {
        return { error: "provide a plugin spec (github:owner/repo or a local path)" };
      }
      const result = await installPlugin(req.spec);
      return { data: result };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("plugins:uninstall", (_e, req: { id: string }) => {
    try {
      if (!req || typeof req.id !== "string") return { error: "missing plugin id" };
      uninstallPlugin(req.id);
      return { data: { ok: true } };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  if (!pluginsDevEnabled()) return;
  const root = getPluginsRoot();
  if (!root || watcher) return;
  try {
    fs.mkdirSync(root, { recursive: true });
    watcher = fs.watch(root, { persistent: false }, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const wc = getWebContents();
        if (wc && !wc.isDestroyed()) wc.send("plugins:ui-changed");
      }, 200);
    });
  } catch (err) {
    console.error("[cairn-plugins] ui watcher failed:", err instanceof Error ? err.message : err);
  }
}
