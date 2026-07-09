#!/usr/bin/env node
/**
 * Cross-platform native binary provisioning script.
 *
 * Historically this COMPILED better-sqlite3 (via @electron/rebuild) and node-pty
 * from source on every runner. Both ship prebuilt binaries, so we now DOWNLOAD
 * them instead — which is faster and, crucially, lets a single macOS (arm64)
 * runner produce BOTH arm64 and x64 binaries for a universal mac build.
 *
 * better-sqlite3 (per-ABI prebuilds via prebuild-install):
 *   - Electron ABI  → electron-native/<arch>/better_sqlite3_electron.node
 *                     (loaded by electron/db/client.ts, arch-selected at runtime)
 *   - pkg Node ABI  → pkg-native/<arch>/better_sqlite3.node
 *                     (embedded in cairn-mcp / cairn-mcp-x64 binaries)
 *   - vitest        → vitest-native/better_sqlite3.node (host Node ABI, tests)
 *
 * node-pty ships N-API prebuilds under node_modules/node-pty/prebuilds/
 * (<platform>-<arch>/). N-API is ABI-stable across Node/Electron versions, so
 * NO rebuild is needed — electron-builder packages the matching prebuild per
 * arch. We only sanity-check the prebuilds exist here.
 *
 * On macOS both arches are provisioned. On Windows/Linux only the host arch
 * (x64) is provisioned — the runtime resolver keys on process.arch.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

// Node version baked into the pkg binary — must match PKG_NODE_TARGET in build scripts.
const PKG_NODE_VERSION = "24";
// Electron version we ship — better-sqlite3 electron prebuilds are keyed by this.
const ELECTRON_VERSION = require(path.join(root, "node_modules", "electron", "package.json")).version;

const bsqliteDir = path.join(root, "node_modules", "better-sqlite3");
const releasePath = path.join(bsqliteDir, "build", "Release", "better_sqlite3.node");

// macOS builds are universal (both arches); other platforms build the host arch only.
const ARCHES = process.platform === "darwin" ? ["arm64", "x64"] : [process.arch];

const prebuildBin = process.platform === "win32"
  ? path.join(root, "node_modules", ".bin", "prebuild-install.cmd")
  : path.join(root, "node_modules", ".bin", "prebuild-install");

function run(cmd, cwd = root) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd });
}

function copyBinary(dest, label) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(releasePath, dest);
  console.log(`Copied ${label} → ${path.relative(root, dest)}`);
}

/**
 * Download a better-sqlite3 prebuilt binary for the given runtime/arch and copy
 * it to `dest`. Runs prebuild-install from the better-sqlite3 dir so it reads
 * its own package.json when resolving the GitHub release URL.
 */
function fetchPrebuild({ runtime, target, arch, dest, label }) {
  console.log(`\n> prebuild-install ${runtime} ${target} ${process.platform}-${arch}`);
  execSync(
    `"${prebuildBin}" --runtime ${runtime} --target ${target} --arch ${arch}` +
      ` --platform ${process.platform} --tag-prefix v --verbose`,
    { stdio: "inherit", cwd: bsqliteDir },
  );
  copyBinary(dest, label);
}

// ── better-sqlite3: Electron ABI (per arch) ──────────────────────────────────
for (const arch of ARCHES) {
  fetchPrebuild({
    runtime: "electron",
    target: ELECTRON_VERSION,
    arch,
    dest: path.join(root, "electron-native", arch, "better_sqlite3_electron.node"),
    label: `Electron ${ELECTRON_VERSION} ${arch}`,
  });
}

// ── better-sqlite3: pkg Node ABI (per arch, embedded in cairn-mcp) ────────────
for (const arch of ARCHES) {
  fetchPrebuild({
    runtime: "node",
    target: `${PKG_NODE_VERSION}.0.0`,
    arch,
    dest: path.join(root, "pkg-native", arch, "better_sqlite3.node"),
    label: `pkg Node ${PKG_NODE_VERSION} ${arch}`,
  });
}

// ── better-sqlite3: current system Node ABI (for vitest) ─────────────────────
// Rebuild for the running Node so the vitest sqlite shim can load it.
run(`npm rebuild better-sqlite3`);
copyBinary(
  path.join(root, "vitest-native", "better_sqlite3.node"),
  `vitest Node ${process.version} (ABI ${process.versions.modules})`,
);

// ── node-pty ─────────────────────────────────────────────────────────────────
// macOS + Windows ship N-API prebuilds (prebuilds/<platform>-<arch>/pty.node),
// which are ABI-stable — no rebuild needed, electron-builder packages the
// matching arch. Linux ships no prebuild, so node-pty is compiled there.
const nodePtyPrebuilds = path.join(root, "node_modules", "node-pty", "prebuilds");
if (process.platform === "linux") {
  console.log("\n> node-pty has no Linux prebuild — compiling for Electron ABI");
  const rebuildBin = path.join(root, "node_modules", ".bin", "electron-rebuild");
  run(`"${rebuildBin}" -f -o node-pty`);
} else {
  for (const arch of ARCHES) {
    const ptyNode = path.join(nodePtyPrebuilds, `${process.platform}-${arch}`, "pty.node");
    if (!fs.existsSync(ptyNode)) {
      throw new Error(
        `node-pty prebuilt missing: ${path.relative(root, ptyNode)} — ` +
          `expected a shipped N-API prebuild for ${process.platform}-${arch}.`,
      );
    }
    console.log(`node-pty prebuilt present: prebuilds/${process.platform}-${arch}/`);
  }
}

console.log("\nNative provisioning complete.");
