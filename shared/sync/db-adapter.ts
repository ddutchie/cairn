/**
 * Cairn Sync — portable DB adapter interface.
 *
 * The sync engine must run on both better-sqlite3 (desktop/Electron) and
 * expo-sqlite (mobile). Rather than depend on either concrete driver, the
 * engine talks to this minimal synchronous statement API. Each platform
 * provides a thin adapter:
 *   - Desktop: better-sqlite3 already satisfies this shape directly.
 *   - Mobile:  a small wrapper over expo-sqlite's synchronous API.
 *
 * Only the subset the engine actually uses is declared here.
 */

export interface SyncStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SyncDb {
  prepare(sql: string): SyncStatement;
  /**
   * Run `fn` inside a transaction. better-sqlite3 returns a *callable* wrapper
   * from `transaction()`; this signature matches that shape (call the result to
   * execute). Adapters for other drivers should mimic it.
   */
  transaction<T>(fn: () => T): () => T;
}
