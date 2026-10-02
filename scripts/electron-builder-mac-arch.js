/**
 * electron-builder config for a single-arch macOS build (release CI).
 *
 * electron-builder.yml lists `arch: [arm64, x64]` on each mac target, and that
 * explicit list wins over the `--arm64` / `--x64` CLI flags — so a "per-arch" job
 * still packaged and notarized BOTH arches (and the other arch's app was missing
 * its MCP binary, which the job never built). This wraps the base config and
 * pins every mac target to the arch in MAC_ARCH.
 *
 * Usage: MAC_ARCH=arm64 npx electron-builder --mac --config scripts/electron-builder-mac-arch.js
 */
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const arch = process.env.MAC_ARCH;
if (arch !== "arm64" && arch !== "x64") {
  throw new Error(`MAC_ARCH must be "arm64" or "x64" (got ${JSON.stringify(arch)})`);
}

const config = yaml.load(fs.readFileSync(path.join(__dirname, "..", "electron-builder.yml"), "utf8"));
config.mac.target = config.mac.target.map((t) => ({ ...(typeof t === "string" ? { target: t } : t), arch: [arch] }));
module.exports = config;
