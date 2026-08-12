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

// Default to current platform (host arch only, dev convenience)
const platform = process.platform;
const targets = [];
if (wantMac || (!wantWin && !wantLinux && platform === "darwin")) {
  if (wantMac) {
    // Release: universal mac — arm64 canonical + x64 suffixed.
    targets.push({ id: "node24-macos-arm64", out: "cairn-mcp",     arch: "arm64" });
    targets.push({ id: "node24-macos-x64",   out: "cairn-mcp-x64", arch: "x64" });
  } else {
    const arch = process.arch === "x64" ? "x64" : "arm64";
    targets.push({ id: `node24-macos-${arch}`, out: "cairn-mcp", arch });
  }
}
if (wantWin || (!wantMac && !wantWin && !wantLinux && platform === "win32")) {
  // Windows ships x64 ONLY. pkg cannot fabricate a win-arm64 binary on an x64
  // Windows host (it must execute the target Node binary to produce bytecode,
  // and x64 Windows can't run an arm64 exe), so an arm64 MCP binary has never
  // shipped for Windows — the electron-builder win target stays x64 to match.
  const arch = process.arch === "x64" ? "x64" : "arm64";
  targets.push({ id: `node24-win-${arch}`, out: "cairn-mcp.exe", arch });
}
if (wantLinux || (!wantMac && !wantWin && !wantLinux && platform === "linux")) {
  if (wantLinux) {
    // Release: both arches, arch-suffixed (afterPack canonicalises + strips).
    targets.push({ id: "node24-linux-x64",   out: "cairn-mcp-linux-x64",   arch: "x64" });
    targets.push({ id: "node24-linux-arm64", out: "cairn-mcp-linux-arm64", arch: "arm64" });
  } else {
    const arch = process.arch === "x64" ? "x64" : "arm64";
    targets.push({ id: `node24-linux-${arch}`, out: "cairn-mcp-linux", arch });
  }
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
  // standalone (agents run it with the app closed). Multiple arches coexist in
  // dist-mcp/ via the arch-suffixed sidecar + binary names; afterPack strips the
  // non-target arch and canonicalises the surviving binary per platform.
  const sidecar = path.join(outDir, `better_sqlite3-${target.arch}.node`);
  fs.copyFileSync(archNative, sidecar);
  // macOS: re-sign the sidecar at its final path with an explicit identifier.
  // pkg dlopen's this from an ad-hoc-signed process; a fresh signature here
  // avoids dyld code-signature page rejection ("Invalid Page") — and prevents
  // any stale signature-cache state from a previously-crash-loaded file.
  if (process.platform === "darwin") {
    execSync(
      `codesign --force --sign - -i cairn-better-sqlite3-${target.arch} ${JSON.stringify(sidecar)}`,
      { stdio: "inherit" },
    );
  }
  console.log(`[build-mcp-binary] Staged native binding: ${path.basename(sidecar)}`);
}

console.log("\n[build-mcp-binary] Done.");
