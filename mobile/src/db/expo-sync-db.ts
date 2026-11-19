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

/** Transaction depth per database handle, so every adapter made over one handle nests correctly. */
const txState = new WeakMap<object, { depth: number; seq: number }>();

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

  // expo-sqlite's withTransactionSync is a bare BEGIN/COMMIT with no savepoints, so a
  // transaction() entered while another is open (shared code nests them, as
  // better-sqlite3 allows) would fail with "cannot start a transaction within a
  // transaction". Track depth: the outermost call uses the real transaction, inner
  // calls a SAVEPOINT that rolls back alone if its function throws.
  const state = txState.get(db) ?? { depth: 0, seq: 0 };
  txState.set(db, state);

  return {
    prepare,
    transaction<T>(fn: () => T): () => T {
      // Return a callable wrapper (better-sqlite3 semantics): calling it runs
      // `fn` inside a synchronous transaction.
      return () => {
        if (state.depth > 0) {
          const name = `cairn_sp_${++state.seq}`;
          db.execSync(`SAVEPOINT ${name}`);
          state.depth++;
          try {
            const out = fn();
            db.execSync(`RELEASE ${name}`);
            return out;
          } catch (e) {
            db.execSync(`ROLLBACK TO ${name}`);
            db.execSync(`RELEASE ${name}`);
            throw e;
          } finally {
            state.depth--;
          }
        }
        let result: T;
        state.depth++;
        try {
          db.withTransactionSync(() => {
            result = fn();
          });
        } finally {
          state.depth--;
        }
        return result!;
      };
    },
  };
}
