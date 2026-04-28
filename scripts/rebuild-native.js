#!/usr/bin/env node
/**
 * Cross-platform native module rebuild script.
 *
 * Replaces the POSIX-only shell one-liner in package.json that used
 * `mkdir -p` and `cp` — neither of which work on Windows.
 *
 * What this does:
 *   1. Rebuild better-sqlite3 for the system Node ABI
 *   2. Copy the resulting .node binary to mcp-native/ (used by MCP server)
 *   3. Rebuild better-sqlite3 for the Electron ABI (via @electron/rebuild)
 *   4. Copy the resulting .node binary to electron-native/ (used by Electron IPC)
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const releasePath = path.join(root, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root });
}

function copyBinary(dest, label) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(releasePath, dest);
  console.log(`Copied ${label} binary → ${path.relative(root, dest)}`);
}

// Step 1: Build for system Node ABI
run("npm rebuild better-sqlite3");
copyBinary(path.join(root, "mcp-native", "better_sqlite3_node.node"), "system Node");

// Step 2: Build for Electron ABI
run("npx @electron/rebuild -f better-sqlite3");
copyBinary(path.join(root, "electron-native", "better_sqlite3_electron.node"), "Electron");

console.log("\nNative rebuild complete.");
