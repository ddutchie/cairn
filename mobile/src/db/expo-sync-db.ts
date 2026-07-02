/**
 * expo-sqlite adapter for the shared SyncEngine.
 *
 * Bridges expo-sqlite's synchronous API to the portable `SyncDb` interface
 * (shared/sync/db-adapter.ts) so the mobile app runs the IDENTICAL sync engine
 * the desktop uses. This is the "thin adapter" promised in P2.
 *
 * expo-sqlite shapes:
 *   db.prepareSync(sql) -> SQLiteStatement with:
 *     .executeSync(params)  -> SQLiteExecuteSyncResult (iterable of rows;
 *                              also carries changes/lastInsertRowId)
 *     .finalizeSync()
 *   db.withTransactionSync(fn)
 *
 * The SyncDb contract expects prepare().run/get/all and a transaction() that
 * returns a *callable* wrapper (better-sqlite3 style). We reproduce that shape.
 */

import type { SQLiteDatabase } from "expo-sqlite";
import type { SyncDb, SyncStatement } from "@cairn/shared/sync/db-adapter";

function toParams(params: unknown[]): unknown[] {
  // Callers pass positional args like better-sqlite3 (.run(a, b, c)).
  // expo-sqlite's executeSync accepts an array of bind params.
  return params;
}

export function createExpoSyncDb(db: SQLiteDatabase): SyncDb {
  const prepare = (sql: string): SyncStatement => {
    return {
      run(...params: unknown[]) {
        const stmt = db.prepareSync(sql);
        try {
          const res = stmt.executeSync(toParams(params) as never);
          return { changes: res.changes, lastInsertRowId: res.lastInsertRowId };
        } finally {
          stmt.finalizeSync();
        }
      },
      get(...params: unknown[]) {
        const stmt = db.prepareSync(sql);
        try {
          const res = stmt.executeSync(toParams(params) as never);
          const first = res.getFirstSync();
          return first ?? undefined;
        } finally {
          stmt.finalizeSync();
        }
      },
      all(...params: unknown[]) {
        const stmt = db.prepareSync(sql);
        try {
          const res = stmt.executeSync(toParams(params) as never);
          return res.getAllSync() as unknown[];
        } finally {
          stmt.finalizeSync();
        }
      },
    };
  };

  return {
    prepare,
    transaction<T>(fn: () => T): () => T {
      // Return a callable wrapper (better-sqlite3 semantics): calling it runs
      // `fn` inside a synchronous transaction.
      return () => {
        let result: T;
        db.withTransactionSync(() => {
          result = fn();
        });
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return result!;
      };
    },
  };
}
