/**
 * scripts/electron-dev.js
 *
 * Spawns Electron and restarts it whenever dist-electron/main.js or
 * dist-electron/preload.js change (i.e. after esbuild rebuilds them).
 *
 * Used only in `npm run dev` — not in production builds.
 */

const { spawn } = require("child_process");
const chokidar = require("chokidar");
const path = require("path");

const root = path.resolve(__dirname, "..");
const WATCH = [
  path.join(root, "dist-electron", "main.js"),
  path.join(root, "dist-electron", "preload.js"),
];

let child = null;
let restarting = false;

function start() {
  if (child) {
    child.removeAllListeners();
    child.kill();
  }
  console.log("[electron-dev] starting Electron…");
  // Spawn the Electron binary directly rather than via `npx electron` — on
  // Windows, spawning the "npx.cmd" shim without shell:true can throw
  // "spawn EINVAL" depending on the Node version manager's PATH shim (e.g.
  // fnm's per-shell temp dir), and require("electron") already resolves to
  // the real electron.exe/electron binary path.
  child = spawn(
    require("electron"),
    [path.join(root, "dist-electron", "main.js")],
    {
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "development" },
      cwd: root,
    }
  );
  child.on("exit", (code) => {
    if (!restarting) process.exit(code ?? 0);
  });
}

// Wait briefly after a change so both main.js and preload.js are written
// before restarting (esbuild writes them near-simultaneously)
let debounce = null;
chokidar.watch(WATCH, { ignoreInitial: true }).on("change", (f) => {
  console.log(`[electron-dev] ${path.basename(f)} changed — restarting`);
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    restarting = true;
    start();
    setTimeout(() => { restarting = false; }, 2000);
  }, 300);
});

start();
