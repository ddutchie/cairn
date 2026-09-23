/**
 * Drop-in replacement for `@vscode/ripgrep` in the main bundle (esbuild alias
 * in scripts/compile-electron.js + scripts/build.js).
 *
 * dsh-tool-fs-search (glob/grep) spawns `(await import("@vscode/ripgrep")).rgPath`.
 * Upstream resolves the per-platform `@vscode/ripgrep-<platform>-<arch>`
 * package relative to itself, which in the packaged app yields a path inside
 * app.asar. Electron's `spawn` is not asar-aware, so the binary is shipped
 * unpacked (electron-builder.yml) and the path is redirected here.
 */
const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
const platformPkg = `@vscode/ripgrep-${process.platform}-${process.arch}`;

export const rgPath = require
  .resolve(`${platformPkg}/bin/${binaryName}`)
  .replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
