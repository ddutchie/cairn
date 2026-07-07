#!/usr/bin/env node
/**
 * Link the repo-root ../shared folder into this Expo project's node_modules as
 * `@cairn/shared`, so Metro (and TypeScript) resolve the shared sync engine as a
 * normal package instead of an out-of-root relative path.
 *
 * Why: Metro/`expo export` only serve files under the project root. The shared
 * "one brain" code lives at <repo>/shared (a sibling of mobile/), outside that
 * root. A node_modules symlink is the standard, EAS-compatible way to consume
 * out-of-tree source without duplicating it (see docs/plans/mobile-app-viability.md §3).
 *
 * Idempotent: safe to run on every `npm install` via the postinstall hook.
 */

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(projectRoot, "..");
const sharedSrc = path.join(repoRoot, "shared");
const scopeDir = path.join(projectRoot, "node_modules", "@cairn");
const linkPath = path.join(scopeDir, "shared");

function main() {
  if (!fs.existsSync(sharedSrc)) {
    console.warn(`[link-shared] shared source not found at ${sharedSrc} — skipping`);
    return;
  }

  fs.mkdirSync(scopeDir, { recursive: true });

  // Remove any stale link/dir so the symlink target is always current.
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isDirectory() || stat.isFile()) {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch {
    // nothing there yet
  }

  // Relative symlink so the link stays valid if the repo is moved/cloned.
  const relTarget = path.relative(scopeDir, sharedSrc);
  fs.symlinkSync(relTarget, linkPath, "dir");
  console.log(`[link-shared] linked @cairn/shared -> ${relTarget}`);
}

main();
