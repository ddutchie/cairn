/**
 * Vitest shim for better-sqlite3.
 *
 * better-sqlite3 v13+ ships N-API prebuilds (ABI-stable), so vitest could load
 * the package directly — but we keep the shim so tests run against the same
 * vitest-native/ copy that `npm run rebuild` provisions, mirroring how the app
 * resolves the addon at runtime.
 *
 * The binding path is taken from `process.env.BETTER_SQLITE3_BINDING` (set in
 * vitest.config.ts) so the location is configured in one place; falls back to
 * vitest-native/better_sqlite3.node for safety.
 *
 * v13's package `exports` map blocks deep imports like `better-sqlite3/lib/*`,
 * so the main entry (the Database constructor, which accepts `nativeBinding`)
 * is used instead.
 *
 * Usage: aliased in vitest.config.ts resolve.alias.
 */
"use strict";

const path = require("path");
const nativeBinding =
  process.env.BETTER_SQLITE3_BINDING ||
  path.resolve(__dirname, "vitest-native/better_sqlite3.node");
const Database = require("better-sqlite3");

function BetterSqlite3(filename, options) {
  return new Database(filename, { nativeBinding, ...(options || {}) });
}

// Expose static methods from the original class
BetterSqlite3.prototype = Database.prototype;

module.exports = BetterSqlite3;
module.exports.default = BetterSqlite3;
