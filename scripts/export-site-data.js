/**
 * scripts/export-site-data.js
 *
 * Emits the Cairn app's tool + view inventory as JSON for the marketing site
 * (cairn-site/docs/_tools.json descriptions, docs/_views.json shortcuts table).
 *
 * Usage: node scripts/export-site-data.js > /tmp/site-data.json
 *
 * The site keeps marketing-tuned copy, so this output is a DIFF source, not a
 * drop-in: during a release sync, compare it against the site's JSON to spot
 * added/removed/renamed tools (e.g. get_today) or shortcut-order changes,
 * then update the site data + run `node sync-site.mjs` there.
 *
 * Implemented via esbuild bundling (same pattern as compile-electron.js) so
 * the TypeScript sources are read directly — no hand-copied lists to rot.
 */

const esbuild = require("esbuild");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-site-data-")), "site-data.cjs");

esbuild.buildSync({
  entryPoints: [path.join(__dirname, "site-data-entry.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: outFile,
  alias: { "@": path.join(__dirname, "..", "src") },
  logLevel: "silent",
});

const { siteData } = require(outFile);
const pkg = require(path.join(__dirname, "..", "package.json"));
console.log(JSON.stringify({ version: `v${pkg.version}`, ...siteData }, null, 2));
