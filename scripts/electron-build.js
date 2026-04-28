/**
 * Electron build script
 *
 * Next.js `output: export` cannot include API routes (they require a server).
 * In Electron, the chat AI loop runs via IPC in the main process, so the
 * API routes are not needed in the static export.
 *
 * This script temporarily moves src/app/api/ aside, runs the static export,
 * then restores it — keeping the routes available for web/dev mode.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const apiDir = path.join(root, "src", "app", "api");
const apiDirHidden = path.join(root, "src", "app", "_api_hidden");

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root });
}

// Hide API routes from Next.js static export
if (fs.existsSync(apiDir)) {
  fs.renameSync(apiDir, apiDirHidden);
  console.log("Moved api/ aside for static export");
}

try {
  run("cross-env ELECTRON_BUILD=true next build");
  run("tsc -p tsconfig.electron.json");
  run("tsc -p tsconfig.mcp.json");
  run("electron-builder");
} finally {
  // Always restore API routes
  if (fs.existsSync(apiDirHidden)) {
    fs.renameSync(apiDirHidden, apiDir);
    console.log("Restored api/");
  }
}
