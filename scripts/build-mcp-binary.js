#!/usr/bin/env node
/**
 * Cairn — MCP binary builder
 *
 * Compiles the MCP server into a self-contained executable using
 * @yao-pkg/pkg. The binary bundles Node 22 and the mcp-server.bundle.js,
 * with better-sqlite3's native .node file embedded as an asset.
 *
 * The binary is platform-specific and produced in dist-mcp/:
 *   dist-mcp/cairn-mcp          (macOS)
 *   dist-mcp/cairn-mcp.exe      (Windows)
 *   dist-mcp/cairn-mcp-linux    (Linux)
 *
 * Usage:
 *   node scripts/build-mcp-binary.js [--mac] [--win] [--linux]
 *   (defaults to current platform if no flag given)
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "..");
const bundlePath = path.join(root, "dist-mcp", "mcp-server.bundle.js");
const nativePath = path.join(root, "pkg-native", "better_sqlite3.node");
const outDir = path.join(root, "dist-mcp");

const args = process.argv.slice(2);
const wantMac   = args.includes("--mac");
const wantWin   = args.includes("--win");
const wantLinux = args.includes("--linux");

// Default to current platform
const platform = process.platform;
const targets = [];
if (wantMac   || (!wantMac && !wantWin && !wantLinux && platform === "darwin"))  targets.push({ id: "node22-macos-arm64",  out: "cairn-mcp" });
if (wantWin   || (!wantMac && !wantWin && !wantLinux && platform === "win32"))   targets.push({ id: "node22-win-x64",      out: "cairn-mcp.exe" });
if (wantLinux || (!wantMac && !wantWin && !wantLinux && platform === "linux"))   targets.push({ id: "node22-linux-x64",    out: "cairn-mcp-linux" });

// CI: explicit flags add all relevant arches
if (wantMac) {
  targets.push({ id: "node22-macos-x64", out: "cairn-mcp-x64" });
}

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root });
}

if (!fs.existsSync(bundlePath)) {
  console.error(`[build-mcp-binary] Bundle not found: ${bundlePath}`);
  console.error("Run npm run compile first.");
  process.exit(1);
}

if (!fs.existsSync(nativePath)) {
  console.error(`[build-mcp-binary] Native binding not found: ${nativePath}`);
  console.error("Run npm run rebuild first.");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

for (const target of targets) {
  const outPath = path.join(outDir, target.out);
  console.log(`\n[build-mcp-binary] Building ${target.id} → ${target.out}`);
  run(
    `npx pkg dist-mcp/mcp-server.bundle.js` +
    ` --target ${target.id}` +
    ` --config pkg.config.js` +
    ` --output ${outPath}`
  );
  console.log(`[build-mcp-binary] Written: ${outPath}`);
}

console.log("\n[build-mcp-binary] Done.");
