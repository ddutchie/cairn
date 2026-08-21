/**
 * The Cairn plugin-UI API — what a UI plugin's renderer half receives.
 *
 * A UI plugin is a module exporting `activate(ui)`. Cairn calls it with this API
 * so the plugin never imports Cairn internals (it lives in <userData>/plugins,
 * outside the app bundle). It also gets React so it can build components without
 * bundling its own copy (one React instance — critical).
 *
 *   // my-overlay.plugin.js
 *   export function activate(ui) {
 *     const { React } = ui;
 *     function Cat() { ... }
 *     ui.registerOverlay('bouncing-cat', Cat);
 *   }
 *
 * Registrations are auto-tracked per plugin id so a live reload / unload can
 * dispose them.
 */
import * as React from "react";
import type { SlotName, SlotComponent } from "./slot-matrix";
import { registerSlot, type RegisterOptions } from "./registry";
import { resolveSlotName } from "./dsh-slot-map";
import { makeDshClientCtx, type DshClientPlugin } from "./dsh-client-ctx";

export interface CairnPluginUI {
  /** React (use this — do NOT bundle your own; one instance only). */
  React: typeof React;
  /** Register a frame-wide floating overlay component (e.g. a bouncing cat). */
  registerOverlay: (id: string, component: SlotComponent<"app.overlay">, order?: number) => void;
  /** Register a status-bar item. */
  registerStatusBarItem: (id: string, component: SlotComponent<"app.statusbar">, order?: number) => void;
  /** Register a chat-footer widget (cost/context; gets Cairn's live usage). */
  registerChatFooter: (id: string, component: SlotComponent<"chat.transcript.footer">, order?: number) => void;
  /** Register a keyed tool.call.toolview (keyed by tool name). */
  registerToolView: (toolName: string, component: SlotComponent<"tool.call.toolview">) => void;
  /** Low-level escape hatch: register into any slot. */
  register: <K extends SlotName>(name: K, opts: RegisterOptions, component: SlotComponent<K>) => void;
  /**
   * dsh-compatibility: register by a slot name that may be a DSH slot name
   * (e.g. "shell.overlay", "conversation.composer.dock") or a Cairn slot name.
   * The name is resolved through the dsh⇄Cairn alias map; unmappable dsh slots
   * (conversation.*, root, …) are rejected with a console warning. Lets a
   * self-contained dsh UI plugin register unmodified.
   */
  registerBySlot: (slotName: string, opts: RegisterOptions, component: React.ComponentType<Record<string, unknown>>) => void;
}

export interface UIPluginModule {
  activate: (ui: CairnPluginUI) => void | (() => void);
}

const disposersByPlugin = new Map<string, Array<() => void>>();

/** Per-plugin disposer collector (live unload disposes all). */
function trackerFor(pluginId: string): (d: () => void) => void {
  return (d: () => void) => {
    const arr = disposersByPlugin.get(pluginId) ?? [];
    arr.push(d);
    disposersByPlugin.set(pluginId, arr);
  };
}

function apiFor(pluginId: string): CairnPluginUI {
  const track = trackerFor(pluginId);
  return {
    React,
    registerOverlay: (id, c, order) => track(registerSlot("app.overlay", { id: `${pluginId}:${id}`, order }, c)),
    registerStatusBarItem: (id, c, order) => track(registerSlot("app.statusbar", { id: `${pluginId}:${id}`, order }, c)),
    registerChatFooter: (id, c, order) => track(registerSlot("chat.transcript.footer", { id: `${pluginId}:${id}`, order }, c)),
    registerToolView: (toolName, c) => track(registerSlot("tool.call.toolview", { id: `${pluginId}:tool:${toolName}`, key: toolName }, c)),
    register: (name, opts, c) => track(registerSlot(name, { ...opts, id: `${pluginId}:${opts.id}` }, c)),
    registerBySlot: (slotName, opts, c) => {
      const resolved = resolveSlotName(slotName);
      if (!resolved) {
        console.warn(`[plugin-ui] '${pluginId}' targeted slot '${slotName}' which has no Cairn equivalent (shell-only or unknown) — skipped. See dsh-slot-map.ts.`);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      track(registerSlot(resolved, { ...opts, id: `${pluginId}:${opts.id}` }, c as any));
    },
  };
}

/** Activate a plugin module under an id (idempotent: re-activating disposes
 *  first). Accepts BOTH entry shapes:
 *   - Cairn native:  `export function activate(ui)`  (uses the ui API)
 *   - dsh client:    `export function apply(ctx)` + `inject:['slots']`
 *     (a real dsh community client plugin — driven via the dsh ctx shim). */
export function activateUIPlugin(pluginId: string, mod: UIPluginModule | DshClientPlugin): void {
  deactivateUIPlugin(pluginId);
  const track = trackerFor(pluginId);
  // Cairn-native form.
  if (typeof (mod as UIPluginModule).activate === "function") {
    try {
      const ret = (mod as UIPluginModule).activate(apiFor(pluginId));
      if (typeof ret === "function") track(ret);
    } catch (err) {
      console.error(`[plugin-ui] '${pluginId}' activate() threw:`, err);
    }
    return;
  }
  // dsh client form: apply(ctx) driving ctx.slots.* through the shim.
  if (typeof (mod as DshClientPlugin).apply === "function") {
    try {
      const ctx = makeDshClientCtx(pluginId, track);
      const ret = (mod as DshClientPlugin).apply(ctx);
      if (typeof ret === "function") track(ret);
    } catch (err) {
      console.error(`[plugin-ui] '${pluginId}' apply(ctx) threw:`, err);
    }
    return;
  }
  console.error(`[plugin-ui] '${pluginId}' exports neither activate(ui) nor apply(ctx)`);
}

/** Dispose all registrations a plugin made (live unload). */
export function deactivateUIPlugin(pluginId: string): void {
  const arr = disposersByPlugin.get(pluginId);
  if (!arr) return;
  for (const d of arr) { try { d(); } catch { /* ignore */ } }
  disposersByPlugin.delete(pluginId);
}

export function activeUIPluginIds(): string[] {
  return [...disposersByPlugin.keys()];
}
