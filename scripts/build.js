#!/usr/bin/env node
/**
 * Cairn build script
 *
 * Usage:
 *   node scripts/build.js --mac       Build macOS DMG (arm64 + x64)
 *   node scripts/build.js --win       Build Windows NSIS installer (x64 + arm64)
 *   node scripts/build.js --linux     Build Linux AppImage (x64 + arm64)
 *   node scripts/build.js --mac --win Build multiple platforms
 *
 * Steps:
 *   1. Next.js static export (output: export)
 *   2. Compile Electron main process (tsc)
 *   3. Compile + bundle MCP server (tsc + esbuild)
 *   4. electron-builder for the requested platform(s)
 */

const { execSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const platforms = {
  mac:   args.includes("--mac"),
  win:   args.includes("--win"),
  linux: args.includes("--linux"),
};

if (!platforms.mac && !platforms.win && !platforms.linux) {
  console.error("Usage: node scripts/build.js [--mac] [--win] [--linux]");
  console.error("At least one platform flag is required.");
  process.exit(1);
}

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root });
}

// Build platform flags for electron-builder
const platformFlags = [
  platforms.mac   && "--mac",
  platforms.win   && "--win",
  platforms.linux && "--linux",
].filter(Boolean).join(" ");

console.log(`\nBuilding Cairn for: ${platformFlags}`);

// 1. Generate licenses + stack metadata (baked into the Next.js static export)
run("node scripts/generate-licenses.js");

// 2. Next.js static export
run("cross-env ELECTRON_BUILD=true next build");

// 3. Bundle Electron main + preload with esbuild (inlines all deps except better-sqlite3 and electron)
run("esbuild electron/main.ts electron/preload.ts --bundle --platform=node --target=node20 --external:electron --external:better-sqlite3 --outdir=dist-electron --format=cjs");

// 4. Bundle MCP server with esbuild (inlines all deps except better-sqlite3)
run("esbuild electron/mcp-server.ts --bundle --platform=node --target=node22 --external:better-sqlite3 --outfile=dist-mcp/mcp-server.bundle.js --format=cjs");

// 5. Build self-contained cairn-mcp binary (bundles Node 22 + better-sqlite3)
run(`node scripts/build-mcp-binary.js ${platformFlags}`);

// 6. Package with electron-builder
run(`electron-builder ${platformFlags}`);

console.log("\nBuild complete. Output in dist-app/");
