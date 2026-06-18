/**
 * Vitest shim for better-sqlite3.
 *
 * After `npm run rebuild`, node_modules/better-sqlite3 has the Electron ABI.
 * Vitest runs under the system Node and needs the system ABI from vitest-native/.
 * `npm run rebuild` saves that copy before the Electron rebuild overwrites node_modules.
 *
 * The binding path is taken from `process.env.BETTER_SQLITE3_BINDING` (set in
 * vitest.config.ts) so the location is configured in one place; falls back to
 * vitest-native/better_sqlite3.node for safety.
 *
 * Usage: aliased in vitest.config.ts resolve.alias.
 */
"use strict";

const path = require("path");
const nativeBinding =
  process.env.BETTER_SQLITE3_BINDING ||
  path.resolve(__dirname, "vitest-native/better_sqlite3.node");
const Database = require("better-sqlite3/lib/database.js");

function BetterSqlite3(filename, options) {
  return new Database(filename, { nativeBinding, ...(options || {}) });
}

// Expose static methods from the original class
BetterSqlite3.prototype = Database.prototype;

module.exports = BetterSqlite3;
module.exports.default = BetterSqlite3;
