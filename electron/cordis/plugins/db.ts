import type { Context } from "@deepseek-ai/cordis";
import type Database from "better-sqlite3";
import "../ctx-augment";
import { CAIRN_DB, CAIRN_HOST, createHostStore, getHostStore, type HostStore } from "../host-store";

// ── cairn-db ────────────────────────────────────────────────────────────────
export interface CairnDbConfig {
  db: Database.Database;
  /**
   * Prebuilt store (e.g. a test double). Defaults to `createHostStore(db)`.
   * Provided under `CAIRN_HOST` on the same plugin/channel as the raw handle.
   */
  host?: HostStore;
}

/**
 * Owns the Database handle AND the HostStore on the Cordis context. Other
 * Cairn plugins read the store via `getHostStore(ctx)` (or declare
 * `CAIRN_HOST` in `inject`). Constructing the Database stays in
 * electron/db/client.ts (ABI rules); this plugin just carries the
 * already-built handle plus the store bound to it.
 */
export function cairnDbPlugin(ctx: Context, config: CairnDbConfig): (() => void) | void {
  // Idempotent: the plugin is mounted per turn on the shared context, and its
  // disposer runs asynchronously — a back-to-back turn (or a test) can re-mount
  // before teardown settles. `provide` throws on a duplicate key, so skip when
  // the value is already present (it's the same singleton db either way).
  const disposers: Array<() => void> = [];
  if (!ctx.get(CAIRN_DB)) {
    const disposeDb = ctx.provide(CAIRN_DB, config.db);
    if (typeof disposeDb === "function") disposers.push(disposeDb as () => void);
  }
  if (!ctx.get(CAIRN_HOST)) {
    const disposeHost = ctx.provide(CAIRN_HOST, config.host ?? createHostStore(config.db));
    if (typeof disposeHost === "function") disposers.push(disposeHost as () => void);
  }
  if (disposers.length === 0) return;
  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* noop */ }
    }
  };
}

export function getDb(ctx: Context): Database.Database | undefined {
  return ctx.get(CAIRN_DB) as Database.Database | undefined;
}

export function getHost(ctx: Context, fallbackDb?: Database.Database): HostStore | undefined {
  if (fallbackDb) return getHostStore(ctx, fallbackDb);
  // The usage/approval unit harnesses mount with `{ on }`-only fakes (no
  // `get`); only touch ctx.get when it exists so those keep working.
  if (typeof (ctx as unknown as { get?: unknown })?.get !== "function") return undefined;
  return getHostStore(ctx, getDb(ctx));
}
