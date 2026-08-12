/**
 * electron-builder afterPack hook — strip the non-target architecture's native
 * artifacts from each packaged app.
 *
 * Why: mac (and win) are built per-arch (`arch: [arm64, x64]`), but the `files`
 * globs ship BOTH arches' native binaries into every app — the desktop
 * arch-separated `electron-native/<arch>/`, BOTH standalone MCP binaries
 * (`cairn-mcp` = arm64, `cairn-mcp-x64` = x64) with their `better_sqlite3-<arch>.node`
 * sidecars, and node-pty's per-arch prebuilds. At runtime everything resolves by
 * `process.arch`, so the other arch is dead weight — e.g. the arm64 mac DMG was
 * carrying the ~84 MB x64 MCP binary for nothing.
 *
 * This hook runs once per arch-specific pack and deletes only the OTHER arch's
 * files from that app bundle, leaving the target arch's untouched. It is a no-op
 * for a universal build (never both arches at once here) and best-effort: a
 * missing file is fine (already absent / different platform).
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
const path = require("path");
const fs = require("fs");

// electron-builder Arch enum → string. Kept local so we don't need to import
// electron-builder here (this file is required by it at runtime).
const ARCH_NAME = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

exports.default = async function afterPack(context) {
  const target = ARCH_NAME[context.arch] ?? String(context.arch);
  if (target === "universal") return; // universal must keep every arch

  const other = target === "arm64" ? "x64" : target === "x64" ? "arm64" : null;
  if (!other) return; // unknown/!multi-arch target — leave as-is

  // Resolve the unpacked resources dir inside the packaged app.
  // macOS: <appOutDir>/<Product>.app/Contents/Resources/app.asar.unpacked
  // win/linux: <appOutDir>/resources/app.asar.unpacked
  const platform = context.electronPlatformName; // 'darwin' | 'win32' | 'linux'
  const appName = context.packager.appInfo.productFilename;
  const resourcesDir = platform === "darwin"
    ? path.join(context.appOutDir, `${appName}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  const unpacked = path.join(resourcesDir, "app.asar.unpacked");

  if (!fs.existsSync(unpacked)) {
    console.log(`[afterPack] no app.asar.unpacked at ${unpacked} — skipping arch strip`);
    return;
  }

  const removed = [];
  const rm = (rel) => {
    const p = path.join(unpacked, rel);
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        removed.push(rel);
      }
    } catch (err) {
      console.warn(`[afterPack] could not remove ${rel}: ${err.message}`);
    }
  };

  // 1. Desktop Electron-ABI better-sqlite3 (electron-native/<arch>/)
  // 1. Desktop Electron-ABI better-sqlite3 (electron-native/<arch>/). Shipped
  //    arch-separated on every platform, so safe to strip the other arch here.
  rm(path.join("electron-native", other));

  // 2. Standalone MCP binary + its sqlite sidecar. Every release build produces
  //    BOTH arches' binaries (arch-suffixed) + sidecars in dist-mcp/; strip the
  //    other arch's, then canonicalise the survivor so every consumer
  //    (app:mcpServerPath, agent configs) references one stable name per
  //    platform regardless of arch.
  //      macOS:  cairn-mcp (arm64) / cairn-mcp-x64 (x64)      → cairn-mcp
  //      win32:  cairn-mcp-win-arm64.exe / -win-x64.exe       → cairn-mcp.exe
  //      linux:  cairn-mcp-linux-arm64 / cairn-mcp-linux-x64  → cairn-mcp-linux
  const mcpNames =
    platform === "darwin"
      ? { x64: "cairn-mcp-x64", arm64: "cairn-mcp" }
      : platform === "win32"
        ? { x64: "cairn-mcp-win-x64.exe", arm64: "cairn-mcp-win-arm64.exe" }
        : { x64: "cairn-mcp-linux-x64", arm64: "cairn-mcp-linux-arm64" };
  const mcpCanonical =
    platform === "darwin" ? "cairn-mcp"
    : platform === "win32" ? "cairn-mcp.exe"
    : "cairn-mcp-linux";

  rm(path.join("dist-mcp", mcpNames[other]));
  rm(path.join("dist-mcp", `better_sqlite3-${other}.node`));
  if (mcpNames[target] !== mcpCanonical) {
    const from = path.join(unpacked, "dist-mcp", mcpNames[target]);
    const to = path.join(unpacked, "dist-mcp", mcpCanonical);
    try {
      if (fs.existsSync(from)) {
        fs.renameSync(from, to);
        removed.push(`renamed ${mcpNames[target]} → ${mcpCanonical}`);
      }
    } catch (err) {
      console.warn(`[afterPack] could not rename ${mcpNames[target]} → ${mcpCanonical}: ${err.message}`);
    }
  }

  // 3. node-pty per-arch prebuilds (e.g. darwin-arm64 / darwin-x64).
  rm(path.join("node_modules", "node-pty", "prebuilds", `${platform}-${other}`));

  console.log(
    `[afterPack] ${platform}/${target}: stripped ${other} arch → ` +
    (removed.length ? removed.join(", ") : "(nothing to remove)"),
  );
};
