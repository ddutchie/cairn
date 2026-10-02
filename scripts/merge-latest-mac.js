#!/usr/bin/env node
/**
 * Merge per-arch electron-builder `latest-mac.yml` files into one.
 *
 * The release builds arm64 and x64 in separate parallel jobs, so each emits a
 * latest-mac.yml listing only its own arch's files. electron-updater picks the
 * right file from the `files:` list by arch, so the published manifest must
 * list both. Top-level `path`/`sha512`/`releaseDate` come from the first file.
 *
 * Text-level merge (no YAML dependency — the publish job has no node_modules);
 * electron-builder's output shape is fixed: scalar keys plus one `files:` list.
 *
 * Usage: node scripts/merge-latest-mac.js <out.yml> <in1.yml> <in2.yml> [...]
 */
const fs = require("fs");

const [out, first, ...rest] = process.argv.slice(2);
if (!out || !first || rest.length === 0) {
  console.error("usage: merge-latest-mac.js <out.yml> <in1.yml> <in2.yml> [...]");
  process.exit(1);
}

/** Returns the indented lines of the `files:` block (list items). */
function filesBlock(lines) {
  const start = lines.findIndex((l) => l.trimEnd() === "files:");
  if (start === -1) throw new Error("no `files:` block");
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith(" ") || lines[end].trim() === "")) end++;
  return { start, end, items: lines.slice(start + 1, end).filter((l) => l.trim() !== "") };
}

const baseLines = fs.readFileSync(first, "utf8").replace(/\r\n/g, "\n").split("\n");
const base = filesBlock(baseLines);
const items = [...base.items];
for (const f of rest) {
  const b = filesBlock(fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n").split("\n"));
  items.push(...b.items);
}

// De-duplicate by url (guards against a re-run passing the same file twice).
const seen = new Set();
const merged = [];
let current = [];
const flush = () => {
  if (!current.length) return;
  const url = current[0].replace(/^\s*-\s*url:\s*/, "").trim();
  if (!seen.has(url)) { seen.add(url); merged.push(...current); }
  current = [];
};
for (const l of items) {
  if (/^\s*-\s/.test(l)) flush();
  current.push(l);
}
flush();

const result = [...baseLines.slice(0, base.start + 1), ...merged, ...baseLines.slice(base.end)].join("\n");
fs.writeFileSync(out, result);
console.log(`[merge-latest-mac] ${seen.size} files → ${out}`);
