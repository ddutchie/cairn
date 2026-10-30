/**
 * Cordis-side view of the host store: the store itself lives in `../agent/host-store`;
 * this adds the `ctx.cairn` plugin channel keys and the lookup that reads them.
 */
import type { Context } from "@deepseek-ai/cordis";
import type Database from "better-sqlite3";
import { createHostStore, type HostStore } from "../agent/host-store";

export * from "../agent/host-store";

/** Service key under which cairnDbPlugin provides the Database handle. */
export const CAIRN_DB = "cairnDb";
/** Service key under which cairnDbPlugin provides the HostStore. Same plugin/channel, second key. */
export const CAIRN_HOST = "cairnHost";

// ── Pure pass-through re-exports (no logic — path funnel only, see header) ──

/**
 * Read the store provided by `cairnDbPlugin` (key `CAIRN_HOST`). Falls back to
 * wrapping the provided raw handle (`CAIRN_DB`) or an explicit `fallbackDb`,
 * so mounts that only carry `db` keep working unchanged. Tolerant of minimal
 * `{ on }`-only test harnesses (no `get`): those resolve via `fallbackDb`.
 */
export function getHostStore(ctx: Context, fallbackDb?: Database.Database): HostStore | undefined {
  const get = (ctx as unknown as { get?: (key: string) => unknown } | null | undefined)?.get;
  const provided = typeof get === "function" ? (get.call(ctx, CAIRN_HOST) as HostStore | undefined) : undefined;
  if (provided) return provided;
  const db = fallbackDb ?? (typeof get === "function" ? (get.call(ctx, CAIRN_DB) as Database.Database | undefined) : undefined);
  return db ? createHostStore(db) : undefined;
}
