/**
 * Mobile schema migrations.
 *
 * The base schema (schema.ts) is create-if-not-exists, which can't evolve an
 * existing install. This adds a versioned path: `PRAGMA user_version` tracks the
 * applied version, and any migration whose index is above it runs in order.
 *
 * To evolve the schema: bump nothing by hand — just append an entry to
 * MIGRATIONS. Each entry runs exactly once per device, in order. Keep them
 * idempotent where cheap (IF NOT EXISTS) so a partially-applied upgrade is safe.
 */

import type * as SQLite from "expo-sqlite";

/**
 * Ordered migrations. Index N (0-based) becomes user_version N+1 once applied.
 * v1 is implicitly the base schema (schema.ts) — start real migrations at the
 * next entry. NEVER edit or reorder existing entries; only append.
 */
const MIGRATIONS: ((db: SQLite.SQLiteDatabase) => void)[] = [
  // Example (leave commented until the first real schema change ships):
  // (db) => db.execSync(`ALTER TABLE notes ADD COLUMN color TEXT`),
];

/** The schema version this build expects (base schema = 1, plus each migration). */
export const MOBILE_SCHEMA_VERSION = 1 + MIGRATIONS.length;

/**
 * Run pending migrations. Assumes the base schema has already been applied
 * (execSync of MOBILE_SCHEMA_SQL). Fresh installs jump straight to the latest
 * version (base schema already includes every current column), so only existing
 * installs from an older build run the intermediate ALTERs.
 */
export function runMigrations(db: SQLite.SQLiteDatabase): void {
  const row = db.getFirstSync<{ user_version: number }>("PRAGMA user_version");
  let version = row?.user_version ?? 0;

  // A brand-new DB (version 0) has just had the full base schema applied, so
  // it's already at the latest shape — stamp it and skip the back-migrations.
  if (version === 0) {
    db.execSync(`PRAGMA user_version = ${MOBILE_SCHEMA_VERSION}`);
    return;
  }

  // Existing install: apply any migrations newer than its recorded version.
  // Migration index i upgrades version (i+1) -> (i+2).
  for (let i = version - 1; i < MIGRATIONS.length; i++) {
    if (i < 0) continue;
    MIGRATIONS[i](db);
    version = i + 2;
    db.execSync(`PRAGMA user_version = ${version}`);
  }
}
