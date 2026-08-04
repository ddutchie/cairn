#!/usr/bin/env node
/**
 * Cairn — "What's New" feature registry generator
 *
 * Reads the curated feature list from scripts/features.config.js, validates it,
 * and writes src/generated/new-features.json — the registry the What's New modal
 * (src/components/layout/NewFeatureModal.tsx) reads at runtime. Mirrors
 * scripts/generate-licenses.js (curated source → generated JSON baked into the
 * static export).
 *
 * Run automatically by build.js before the Next.js build, and by the `dev`
 * script. Can also be run standalone: node scripts/generate-features.js
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const { FEATURES } = require("./features.config.js");

// ── Validation ────────────────────────────────────────────────────────────────
// Fail loudly at generate time rather than shipping a broken/duplicated modal.

const REQUIRED_STRING_FIELDS = ["id", "version", "title", "category", "description"];
const errors = [];
const seenIds = new Set();

if (!Array.isArray(FEATURES)) {
  console.error("[generate-features] FEATURES export must be an array");
  process.exit(1);
}

FEATURES.forEach((f, i) => {
  const where = `entry #${i}${f && f.id ? ` (${f.id})` : ""}`;
  if (!f || typeof f !== "object") {
    errors.push(`${where}: not an object`);
    return;
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof f[field] !== "string" || f[field].trim() === "") {
      errors.push(`${where}: missing/empty string field "${field}"`);
    }
  }
  if (typeof f.id === "string") {
    if (seenIds.has(f.id)) errors.push(`${where}: duplicate id "${f.id}"`);
    seenIds.add(f.id);
  }
  if (typeof f.version === "string" && !/^v\d+\.\d+\.\d+$|^v\d+\.x$|^v\d+\.\d+\.x$/.test(f.version)) {
    errors.push(`${where}: version "${f.version}" should look like "v2.5.9" (or "v2.5.x" / "v1.x" for a condensed release card)`);
  }
  if (!Array.isArray(f.highlights) || f.highlights.length === 0) {
    errors.push(`${where}: "highlights" must be a non-empty array`);
  } else if (!f.highlights.every((h) => typeof h === "string" && h.trim() !== "")) {
    errors.push(`${where}: every highlight must be a non-empty string`);
  }
});

if (errors.length > 0) {
  console.error("[generate-features] Invalid features.config.js:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

// Normalise to exactly the fields the modal consumes (drop any extras).
const registry = FEATURES.map((f) => ({
  id: f.id,
  version: f.version,
  title: f.title,
  category: f.category,
  description: f.description,
  highlights: f.highlights,
}));

const output = { registry, generatedAt: new Date().toISOString() };

const outDir = path.join(root, "src", "generated");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "new-features.json");
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");

const latest = registry.length > 0 ? registry[registry.length - 1].version : "—";
console.log(`[generate-features] Written ${registry.length} feature entries (latest ${latest}) to src/generated/new-features.json`);
