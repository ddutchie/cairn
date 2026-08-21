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
import { ipcMain, type WebContents } from "electron";
import { readEnabledManifest, getPluginsRoot, pluginsDevEnabled } from "../cordis/plugin-loader";

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
