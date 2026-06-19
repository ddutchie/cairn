#!/usr/bin/env node
/**
 * Cairn — Embeddings worker binary builder.
 *
 * Bundles `electron/embeddings/server.ts` into a self-contained executable
 * using @yao-pkg/pkg. The binary bundles Node 22 + the embeddings server,
 * with @xenova/transformers / onnxruntime-node loaded at runtime from
 * `node_modules/` (env-injected).
 *
 * Platform-specific binary, emitted in dist-embeddings/:
 *   dist-embeddings/cairn-embeddings       (macOS / Linux)
 *   dist-embeddings/cairn-embeddings.exe   (Windows)
 *
 * Usage:
 *   node scripts/build-embeddings-binary.js [--mac] [--win] [--linux]
 *   (defaults to current platform if no flag given)
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "..");
const bundlePath = path.join(root, "dist-electron", "embeddings-server.bundle.js");
const outDir = path.join(root, "dist-embeddings");

const args = process.argv.slice(2);
const wantMac   = args.includes("--mac");
const wantWin   = args.includes("--win");
const wantLinux = args.includes("--linux");

const platform = process.platform;
const targets = [];
if (wantMac   || (!wantMac && !wantWin && !wantLinux && platform === "darwin"))  targets.push({ id: "node22-macos-arm64", out: "cairn-embeddings" });
if (wantWin   || (!wantMac && !wantWin && !wantLinux && platform === "win32"))   targets.push({ id: "node22-win-x64",     out: "cairn-embeddings.exe" });
if (wantLinux || (!wantMac && !wantWin && !wantLinux && platform === "linux"))   targets.push({ id: "node22-linux-x64",   out: "cairn-embeddings" });

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root });
}

if (!fs.existsSync(bundlePath)) {
  console.error(`[build-embeddings-binary] Bundle not found: ${bundlePath}`);
  console.error("Run `npm run compile` first.");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

for (const target of targets) {
  const outPath = path.join(outDir, target.out);
  console.log(`\n[build-embeddings-binary] Building ${target.id} → ${target.out}`);
  run(
    `npx pkg dist-electron/embeddings-server.bundle.js` +
    ` --target ${target.id}` +
    ` --config pkg.config.js` +
    ` --output ${outPath}`
  );
  console.log(`[build-embeddings-binary] Written: ${outPath}`);
}

console.log("\n[build-embeddings-binary] Done. Note: onnxruntime-node's native binaries");
console.log("and the @xenova/transformers model cache must be supplied alongside this");
console.log("binary (e.g. via electron-builder `asarUnpack` or TRANSFORMERS_CACHE env).");
