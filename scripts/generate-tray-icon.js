#!/usr/bin/env node
/**
 * Cairn — Tray icon generator
 *
 * Converts public/icon_tray.png into macOS template images:
 *   public/trayTemplate.png      (22×22)
 *   public/trayTemplate@2x.png  (44×44)
 *
 * Template images must be black + transparent only — macOS recolours
 * them automatically for dark/light mode. This script extracts the
 * alpha channel from icon_tray.png and replaces RGB with pure black.
 *
 * Usage: node scripts/generate-tray-icon.js
 */

const sharp = require("sharp");
const path = require("path");

const SOURCE = path.join(__dirname, "..", "public", "icon_tray.png");

async function makeTemplate(size, outFile) {
  const { data } = await sharp(SOURCE)
    .resize(size, size)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4 + 0] = 0; // R
    out[i * 4 + 1] = 0; // G
    out[i * 4 + 2] = 0; // B
    out[i * 4 + 3] = data[i * 4 + 3]; // A from source
  }

  await sharp(out, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toFile(outFile);

  console.log(`[generate-tray-icon] Written ${outFile}`);
}

Promise.all([
  makeTemplate(22, path.join(__dirname, "..", "public", "trayTemplate.png")),
  makeTemplate(44, path.join(__dirname, "..", "public", "trayTemplate@2x.png")),
]).catch((err) => {
  console.error("[generate-tray-icon] Error:", err.message);
  process.exit(1);
});
