/**
 * dsh client `ctx` shim — the facade a real dsh community client plugin's
 * `apply(ctx)` receives, backed by Cairn's plugin-ui slot registry.
 *
 * A dsh client plugin (e.g. dsh-visualize) exports `{ name, inject, apply }` and
 * calls `ctx.slots.inject(slot, () => ctx.slots.register({ name, key?, id?,
 * order? }, Component))`. This shim provides exactly that surface, mapping dsh
 * slot names through the dsh⇄Cairn alias (shell.overlay→app.overlay,
 * tool.call.toolview→same, conversation.composer.dock→chat.transcript.footer,
 * …) onto registerSlot. Registrations are tracked per plugin id so a live
 * reload/unload disposes them (matching activateUIPlugin's model).
 *
 * Scope: only the `slots` seam is provided (that's what self-contained UI
 * plugins use). Other Cordis-context seams (ctx.remote/connection/sessions/
 * locale) are NOT wired — a plugin that injects them is reported unsupported by
 * the loader (KNOWN_UNPROVIDED), rather than silently half-working.
 */
import type { ComponentType } from "react";
import { registerSlot } from "./registry";
import { resolveSlotName } from "./dsh-slot-map";

interface DshRegisterOptions {
  name: string;
  key?: string;
  id?: string;
  order?: number;
  // children/store/inject/locale exist in dsh but aren't needed by keyed/list
  // toolview + overlay registrants; accepted and ignored.
  [k: string]: unknown;
}

export interface DshClientCtx {
  slots: {
    register: (options: DshRegisterOptions, component: ComponentType<Record<string, unknown>>) => () => void;
    inject: (key: string, factory: () => unknown) => () => void;
    entries: (key: string) => unknown[];
  };
  /** cordis effect seam: run fn now, return its disposer. */
  effect: (fn: () => void | (() => void), label?: string) => () => void;
  /** cordis service getter — only 'slots' is meaningful here. */
  get: (key: string) => unknown;
  /** No-op event emitter (dsh plugins rarely emit from apply). */
  on: (event: string, cb: (...a: unknown[]) => void) => () => void;
  emit: (event: string, ...args: unknown[]) => void;
}

/** A dsh client plugin module (its runtime export shape). */
export interface DshClientPlugin {
  name?: string;
  inject?: string[];
  apply: (ctx: DshClientCtx) => void | (() => void);
}

/**
 * Build a ctx facade for one plugin id. `track` collects every disposer the
 * plugin creates so the caller can dispose them all on unload.
 */
export function makeDshClientCtx(pluginId: string, track: (d: () => void) => void): DshClientCtx {
  const slots = {
    register: (options: DshRegisterOptions, component: ComponentType<Record<string, unknown>>): (() => void) => {
      const cairnSlot = resolveSlotName(options.name);
      if (!cairnSlot) {
        console.warn(`[plugin-ui] '${pluginId}' ctx.slots.register('${options.name}') has no Cairn slot (shell-only/unknown) — skipped. See dsh-slot-map.ts.`);
        return () => {};
      }
      const id = options.id ?? (options.key ? `${pluginId}:${options.key}` : `${pluginId}:${cairnSlot}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dispose = registerSlot(cairnSlot, { id, key: options.key, order: options.order }, component as any);
      track(dispose);
      return dispose;
    },
    // dsh's inject waits for a slot DECLARATION before registering (to avoid
    // racing boot). Cairn's slots are always declared (static hosts), so we run
    // the factory immediately. Any disposer it returns is tracked.
    inject: (_key: string, factory: () => unknown): (() => void) => {
      try {
        const r = factory();
        if (typeof r === "function") { track(r as () => void); return r as () => void; }
      } catch (err) {
        console.error(`[plugin-ui] '${pluginId}' ctx.slots.inject factory threw:`, err);
      }
      return () => {};
    },
    entries: (_key: string): unknown[] => [],
  };

  return {
    slots,
    effect: (fn, _label) => {
      try {
        const r = fn();
        if (typeof r === "function") { track(r); return r; }
      } catch (err) {
        console.error(`[plugin-ui] '${pluginId}' ctx.effect threw:`, err);
      }
      return () => {};
    },
    get: (key: string) => (key === "slots" ? slots : undefined),
    on: () => () => {},
    emit: () => {},
  };
}
