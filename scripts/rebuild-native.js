#!/usr/bin/env node
/**
 * Cross-platform native module rebuild script.
 *
 * Replaces the POSIX-only shell one-liner in package.json that used
 * `mkdir -p` and `cp` — neither of which work on Windows.
 *
 * What this does:
 *   1. Rebuild better-sqlite3 for the pkg-bundled Node ABI (node22)
 *   2. Copy the resulting .node binary to pkg-native/ (embedded in cairn-mcp binary)
 *   3. Rebuild better-sqlite3 for the Electron ABI (via @electron/rebuild)
 *   4. Copy the resulting .node binary to electron-native/ (used by Electron IPC)
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const releasePath = path.join(root, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");

// The Node version baked into the pkg binary — must match PKG_NODE_TARGET in build scripts
const PKG_NODE_VERSION = "22";

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root });
}

function copyBinary(dest, label) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(releasePath, dest);
  console.log(`Copied ${label} binary → ${path.relative(root, dest)}`);
}

// Step 1: Build/download better-sqlite3 for pkg-bundled Node 22 ABI.
// Must run from the better-sqlite3 directory so prebuild-install reads its
// own package.json (not ours) when resolving the GitHub release URL.
const bsqliteDir = path.join(root, "node_modules", "better-sqlite3");
console.log(`\n> prebuild-install --target ${PKG_NODE_VERSION}.0.0 (from ${bsqliteDir})`);
execSync(
  `node "${path.join(root, "node_modules", ".bin", "prebuild-install")}" --target ${PKG_NODE_VERSION}.0.0 --runtime node --verbose`,
  { stdio: "inherit", cwd: bsqliteDir }
);
copyBinary(path.join(root, "pkg-native", "better_sqlite3.node"), `pkg Node ${PKG_NODE_VERSION}`);

// Step 2: Build for Electron ABI
run("npx @electron/rebuild -f better-sqlite3");
copyBinary(path.join(root, "electron-native", "better_sqlite3_electron.node"), "Electron");

console.log("\nNative rebuild complete.");
