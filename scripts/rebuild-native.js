#!/usr/bin/env node
/**
 * Cross-platform native binary provisioning script.
 *
 * better-sqlite3 v13+ is built on the N-API, so it ships per-(platform,arch)
 * prebuilt binaries INSIDE the package (node_modules/better-sqlite3/prebuilds/
 * <platform>-<arch>.node). N-API is ABI-stable, so the SAME binary serves the
 * Electron main process, the pkg cairn-mcp runtime (Node 24) and vitest.
 *
 * We still keep arch-separated copies so a single macOS (arm64) runner can
 * produce BOTH arm64 and x64 binaries for a universal mac build, resolved at
 * runtime via process.arch:
 *
 *   - Electron  → electron-native/<arch>/better_sqlite3_electron.node
 *                 (loaded by electron/db/client.ts, arch-selected at runtime)
 *   - pkg Node  → pkg-native/<arch>/better_sqlite3.node
 *                 (embedded in cairn-mcp / cairn-mcp-x64 binaries)
 *   - vitest    → vitest-native/better_sqlite3.node (host arch, tests)
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
// Electron version we ship — kept in the label for clarity (N-API ignores it).
const ELECTRON_VERSION = require(path.join(root, "node_modules", "electron", "package.json")).version;

const bsqliteDir = path.join(root, "node_modules", "better-sqlite3");
const prebuildsDir = path.join(bsqliteDir, "prebuilds");

// macOS builds are universal (both arches); other platforms build the host arch only.
const ARCHES = process.platform === "darwin" ? ["arm64", "x64"] : [process.arch];

function run(cmd, cwd = root) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd });
}

/**
 * Copy the in-package N-API prebuild for the given arch to `dest`. The same
 * prebuilt binary works across Node, Electron and pkg runtimes (N-API stable);
 * we only fan it out per arch so a universal build can ship both.
 *
 * On macOS the shipped prebuilds are LINKER-signed (CodeDirectory flags
 * 0x20002). When such a library is dlopen'd by a plain ad-hoc-signed process —
 * which is what `pkg` produces for cairn-mcp — dyld fails page validation
 * ("code signature invalid") and SIGKILLs the process at the first DB open.
 * Re-signing each copy with a full ad-hoc signature makes it loadable, but the
 * codesign auto-derived identifier (`<basename>-<uuid>`) is STILL rejected by
 * dyld for these filenames, so we must pass an explicit `-i` identifier. Only
 * required on macOS; Linux/Windows have no codesign step.
 */
function copyPrebuild(arch, dest, label) {
  const src = path.join(prebuildsDir, `${process.platform}-${arch}.node`);
  if (!fs.existsSync(src)) {
    throw new Error(
      `better-sqlite3 ${process.platform}-${arch} prebuild missing: ` +
        `${path.relative(root, src)} — reinstall better-sqlite3.`,
    );
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  if (process.platform === "darwin") {
    execSync(
      `codesign --force --sign - -i cairn-better-sqlite3-${arch} ${JSON.stringify(dest)}`,
      { stdio: "inherit" },
    );
  }
  console.log(`Copied ${label} (N-API) → ${path.relative(root, dest)}`);
}

// ── better-sqlite3: Electron, pkg cairn-mcp, and vitest ─────────────────────
// v13+ ships N-API prebuilds in-package; one binary per arch serves all three
// runtimes. Prebuilds are keyed by <platform>-<arch>.node (not ABI), so there
// is no separate electron/pkg/vitest download anymore.
for (const arch of ARCHES) {
  copyPrebuild(
    arch,
    path.join(root, "electron-native", arch, "better_sqlite3_electron.node"),
    `Electron ${ELECTRON_VERSION} ${arch}`,
  );
  copyPrebuild(
    arch,
    path.join(root, "pkg-native", arch, "better_sqlite3.node"),
    `pkg Node ${PKG_NODE_VERSION} ${arch}`,
  );
}
copyPrebuild(
  process.arch,
  path.join(root, "vitest-native", "better_sqlite3.node"),
  `vitest Node ${process.version}`,
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
