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

  // 2. Standalone MCP binary + its sqlite sidecar. Only macOS builds TWO MCP
  //    arches (cairn-mcp = arm64, cairn-mcp-x64 = x64) with both sidecars, so
  //    only there is there an "other arch" MCP artifact to strip. win/linux
  //    build a single x64 MCP binary + a single x64 sidecar; leave those alone
  //    (stripping by the pack's arch would wrongly delete the only sidecar on an
  //    arm64 win/linux pack).
  if (platform === "darwin") {
    // Strip the other arch's binary + sidecar…
    rm(path.join("dist-mcp", other === "x64" ? "cairn-mcp-x64" : "cairn-mcp"));
    rm(path.join("dist-mcp", `better_sqlite3-${other}.node`));
    // …then canonicalise the surviving binary to `cairn-mcp` so every consumer
    // (app:mcpServerPath, agent configs) references one stable name regardless
    // of arch. On the x64 pack the survivor is `cairn-mcp-x64` → rename it.
    if (target === "x64") {
      const from = path.join(unpacked, "dist-mcp", "cairn-mcp-x64");
      const to = path.join(unpacked, "dist-mcp", "cairn-mcp");
      try {
        if (fs.existsSync(from)) {
          fs.renameSync(from, to);
          removed.push("renamed cairn-mcp-x64 → cairn-mcp");
        }
      } catch (err) {
        console.warn(`[afterPack] could not rename cairn-mcp-x64 → cairn-mcp: ${err.message}`);
      }
    }
  }

  // 3. node-pty per-arch prebuilds (e.g. darwin-arm64 / darwin-x64).
  rm(path.join("node_modules", "node-pty", "prebuilds", `${platform}-${other}`));

  console.log(
    `[afterPack] ${platform}/${target}: stripped ${other} arch → ` +
    (removed.length ? removed.join(", ") : "(nothing to remove)"),
  );
};
