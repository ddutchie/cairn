#!/usr/bin/env node
/**
 * Cairn — MCP binary builder
 *
 * Compiles the MCP server into a self-contained executable using
 * @yao-pkg/pkg. The binary bundles Node 24 and the mcp-server.bundle.js,
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
const outDir = path.join(root, "dist-mcp");

// better-sqlite3 pkg-Node prebuilds are arch-separated (pkg-native/<arch>/).
// We ship the matching arch binding as a real sidecar next to the binary
// (dist-mcp/better_sqlite3-<arch>.node) rather than embedding it in the pkg
// snapshot — pkg cannot load a native .node from its virtual filesystem.
function nativeForArch(arch) {
  return path.join(root, "pkg-native", arch, "better_sqlite3.node");
}

const args = process.argv.slice(2);
const wantMac   = args.includes("--mac");
const wantWin   = args.includes("--win");
const wantLinux = args.includes("--linux");

// Default to current platform
const platform = process.platform;
const targets = [];
if (wantMac) {
  targets.push({ id: "node24-macos-arm64",  out: "cairn-mcp",     arch: "arm64" });
} else if (!wantWin && !wantLinux && platform === "darwin") {
  const arch = process.arch === "x64" ? "x64" : "arm64";
  targets.push({ id: `node24-macos-${arch}`, out: "cairn-mcp",     arch });
}
if (wantWin   || (!wantMac && !wantWin && !wantLinux && platform === "win32"))   targets.push({ id: "node24-win-x64",      out: "cairn-mcp.exe",   arch: "x64" });
if (wantLinux || (!wantMac && !wantWin && !wantLinux && platform === "linux"))   targets.push({ id: "node24-linux-x64",    out: "cairn-mcp-linux", arch: "x64" });

// CI: explicit --mac adds the x64 arch too (universal mac release).
if (wantMac) {
  targets.push({ id: "node24-macos-x64", out: "cairn-mcp-x64", arch: "x64" });
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

fs.mkdirSync(outDir, { recursive: true });

for (const target of targets) {
  // The arch-matched better-sqlite3 binding is shipped as a real sidecar next to
  // the output binary (not embedded in the pkg snapshot — pkg can't load a .node
  // from its virtual FS). resolveMcpNativeBinding() loads it via process.execPath.
  const archNative = nativeForArch(target.arch);
  if (!fs.existsSync(archNative)) {
    console.error(`[build-mcp-binary] Native binding not found: ${archNative}`);
    console.error("Run npm run rebuild first.");
    process.exit(1);
  }

  const outPath = path.join(outDir, target.out);
  console.log(`\n[build-mcp-binary] Building ${target.id} (${target.arch}) → ${target.out}`);
  run(
    `npx pkg dist-mcp/mcp-server.bundle.js` +
    ` --target ${target.id}` +
    ` --config pkg.config.js` +
    ` --output ${outPath}`
  );
  console.log(`[build-mcp-binary] Written: ${outPath}`);

  // Stage the arch-matched native binding NEXT TO the output binary as
  // `better_sqlite3-<arch>.node` — a real on-disk path resolveMcpNativeBinding()
  // loads via process.execPath. Deterministic and loadable when the binary runs
  // standalone (agents run it with the app closed). Multiple mac arches
  // (cairn-mcp arm64 + cairn-mcp-x64) coexist in dist-mcp/ via the arch suffix.
  const sidecar = path.join(outDir, `better_sqlite3-${target.arch}.node`);
  fs.copyFileSync(archNative, sidecar);
  console.log(`[build-mcp-binary] Staged native binding: ${path.basename(sidecar)}`);
}

console.log("\n[build-mcp-binary] Done.");
