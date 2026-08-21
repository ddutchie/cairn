/**
 * Renderer-side UI-plugin loader. Pulls each enabled UI plugin's source from
 * main (plugins:listUi), evaluates it into a module exporting `activate(ui)`,
 * and activates it against the Cairn plugin-UI API. Re-pulls on plugins:ui-changed
 * so a UI plugin authored/edited while the app runs loads live.
 *
 * The plugin module is evaluated with `new Function` (dev-gated). It is handed a
 * CommonJS-ish shim: `module`, `exports`, and a `require` that only resolves
 * "react" (to Cairn's single instance) — plugins get React via the ui API too.
 * This is a code-exec surface, acceptable only behind CAIRN_PLUGINS_DEV.
 */
import * as React from "react";
import { activateUIPlugin, deactivateUIPlugin, activeUIPluginIds, type UIPluginModule } from "./api";

interface ElectronUiPlugins {
  plugins?: {
    listUi: () => Promise<Array<{ id: string; source: string }>>;
    onUiChanged: (cb: () => void) => () => void;
  };
}

function evalPluginModule(id: string, source: string): UIPluginModule | null {
  const module = { exports: {} as Record<string, unknown> };
  const req = (name: string) => {
    if (name === "react") return React;
    throw new Error(`[plugin-ui] '${id}' require('${name}') is not allowed (use the ui API / ui.React)`);
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("module", "exports", "require", "React", source);
    fn(module, module.exports, req, React);
    const mod = (module.exports.activate ? module.exports : module.exports.default) as UIPluginModule | undefined;
    if (!mod || typeof mod.activate !== "function") {
      console.error(`[plugin-ui] '${id}' must export activate(ui)`);
      return null;
    }
    return mod;
  } catch (err) {
    console.error(`[plugin-ui] '${id}' failed to evaluate:`, err);
    return null;
  }
}

let started = false;

/** Load + activate all UI plugins, and keep them live-synced. Idempotent. */
export function startUIPlugins(): void {
  if (started) return;
  const el = (globalThis as unknown as { electron?: ElectronUiPlugins }).electron;
  if (!el?.plugins) return; // not in Electron, or dev flag off (handler returns [])
  started = true;

  const reload = async () => {
    let list: Array<{ id: string; source: string }> = [];
    try {
      list = await el.plugins!.listUi();
    } catch (err) {
      console.error("[plugin-ui] listUi failed:", err);
      return;
    }
    const desired = new Set(list.map((p) => p.id));
    // Deactivate plugins no longer present.
    for (const id of activeUIPluginIds()) {
      if (!desired.has(id)) deactivateUIPlugin(id);
    }
    // (Re)activate present ones. Re-activation disposes prior registrations, so a
    // live edit refreshes cleanly.
    for (const p of list) {
      const mod = evalPluginModule(p.id, p.source);
      if (mod) activateUIPlugin(p.id, mod);
    }
  };

  void reload();
  el.plugins.onUiChanged(() => void reload());
}
