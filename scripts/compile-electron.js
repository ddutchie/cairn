/**
 * scripts/compile-electron.js
 *
 * Builds the Electron main/preload bundle plus the MCP/embeddings/runtime
 * sidecar bundles via esbuild's Node API instead of the CLI.
 *
 * Why not the CLI: the main/preload build needs an inline --banner:js flag
 * containing a require('url') call, which npm scripts on Windows must pass
 * through two separate shells (npm's cmd.exe, then concurrently's own
 * cmd.exe for --watch) — each with different, incompatible quote-escaping
 * rules. No level of nested quote-escaping survives both hops intact (cmd.exe
 * strips/mismatches quotes it doesn't own), so the banner argument would
 * either error out or get silently corrupted. Using the JS API instead
 * passes the banner as a real string with zero shell involvement.
 *
 * Usage: node scripts/compile-electron.js [--watch]
 */

const fs = require("fs");
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");
// Main/preload + the helpers spawned or loaded beside it. scripts/build.js
// uses this so release builds get the same plugins and shims as dev.
const electronOnly = process.argv.includes("--electron-only");

/**
 * dsh-subprocess-local spawns its containment runner (Win32 Job / systemd
 * scope) as `[process.execPath, runner]`. Upstream's desktop app runs the
 * whole dsh Host with ELECTRON_RUN_AS_NODE=1 (apps/desktop
 * desktopNodeEnvironment), so that spawn inherits Node mode. Cairn runs
 * Cordis in the Electron main process, where it would boot a second Cairn
 * per subprocess. Add ELECTRON_RUN_AS_NODE to the runner's own environment
 * (runnerEnvironment) only; the target command's env travels separately in
 * the launch request. Fails the build if a dsh upgrade moves the line.
 */
const patchSubprocessRunnerEnv = {
  name: "dsh-subprocess-runner-electron-env",
  setup(build) {
    build.onLoad({ filter: /dsh-subprocess-local[\\/]lib[\\/]runner-launch-[^\\/]+\.js$/ }, async (args) => {
      const src = await fs.promises.readFile(args.path, "utf8");
      const needle = "[SUBPROCESS_RUNNER_ENV]: selection,";
      if (src.split(needle).length !== 2) {
        throw new Error(`patchSubprocessRunnerEnv: expected exactly one "${needle}" in ${args.path} — dsh-subprocess-local changed; update scripts/compile-electron.js`);
      }
      return {
        contents: src.replace(needle, `${needle} ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),`),
        loader: "js",
      };
    });
  },
};

/**
 * dsh-ptc-runtime-node launches its bootstrap with `process.execPath` and
 * keeps ELECTRON_RUN_AS_NODE only when the host process already has it (true
 * for upstream's Node-mode desktop host). Cairn runs the harness in the
 * Electron main process, so without this the PTC child (workflow scripts)
 * would boot a second Cairn window instead of Node. Fails the build if a dsh
 * upgrade moves the line.
 */
const patchPtcRuntimeElectronEnv = {
  name: "dsh-ptc-runtime-electron-env",
  setup(build) {
    build.onLoad({ filter: /dsh-ptc-runtime-node[\\/]lib[\\/]index\.js$/ }, async (args) => {
      const src = await fs.promises.readFile(args.path, "utf8");
      const needle = "if (packaged) {\n\t\t\t\tenv.DSH_PTC_RUNTIME_NODE";
      if (src.split(needle).length !== 2) {
        throw new Error(`patchPtcRuntimeElectronEnv: expected exactly one packaged-env block in ${args.path} — dsh-ptc-runtime-node changed; update scripts/compile-electron.js`);
      }
      return {
        contents: src.replace(needle, `if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";\n\t\t\t${needle}`),
        loader: "js",
      };
    });
  },
};

/**
 * dsh-win32-process creates Windows children with CreateProcess(AsUser)W and
 * never sets CREATE_NO_WINDOW. The runners that call it (subprocess runner,
 * Windows sandbox runner) are spawned with windowsHide, so they own no
 * console, and each console-subsystem child (rg.exe for glob/grep, git, …)
 * gets a fresh visible console window that flashes up and closes. OR the flag
 * (0x08000000) into all three call sites. stdio is always redirected through
 * pipes, and GUI children ignore the flag. Fails the build if a dsh upgrade
 * moves the lines.
 */
const CREATE_NO_WINDOW = "0x08000000";
const patchWin32NoWindow = {
  name: "dsh-win32-process-no-window",
  setup(build) {
    build.onLoad({ filter: /dsh-win32-process[\\/]lib[\\/]index\.js$/ }, async (args) => {
      let src = await fs.promises.readFile(args.path, "utf8");
      const edits = [
        // spawnCurrentTokenJobProcess: CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT
        ["null, null, 1, 1028, environment,", `null, null, 1, 1028 | ${CREATE_NO_WINDOW}, environment,`],
        // spawnInheritedJobProcess: CREATE_SUSPENDED
        ["createRestrictedProcess(api, options, commandLine, 4, startupInfo,", `createRestrictedProcess(api, options, commandLine, 4 | ${CREATE_NO_WINDOW}, startupInfo,`],
        // restricted pipe spawn: no flags
        ["buildCommandLine(options.command, options.args), 0, startupInfo,", `buildCommandLine(options.command, options.args), ${CREATE_NO_WINDOW}, startupInfo,`],
      ];
      for (const [needle, replacement] of edits) {
        if (src.split(needle).length !== 2) {
          throw new Error(`patchWin32NoWindow: expected exactly one "${needle}" in ${args.path} — dsh-win32-process changed; update scripts/compile-electron.js`);
        }
        src = src.replace(needle, replacement);
      }
      return { contents: src, loader: "js" };
    });
  },
};

const mainPreload = {
  entryPoints: ["electron/main.ts", "electron/preload.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  external: [
    "electron",
    "better-sqlite3",
    "node-pty",
    "@huggingface/transformers",
    "onnxruntime-node",
    "ajv",
    "ajv-formats",
    // koffi (native FFI, pulled in transitively by dsh-fs-local,
    // dsh-sandbox-windows-acl, dsh-session-persistence-jsonl,
    // dsh-subprocess-local, dsh-win32-process) resolves its prebuilt native
    // binary at runtime relative to import.meta.dirname. Bundling it inlines
    // that lookup into main.js, and esbuild replaces import.meta.dirname
    // with undefined for a cjs/node target — koffi then can't find its
    // native module and throws "Cannot find the native Koffi module" the
    // first time a session flush (or any dsh fs/subprocess call) touches it.
    "koffi",
  ],
  // glob/grep spawn @vscode/ripgrep's rgPath, which points inside app.asar
  // when packaged — the shim redirects it to the unpacked binary.
  alias: { "@vscode/ripgrep": "./electron/lib/ripgrep-path.ts" },
  outdir: "dist-electron",
  format: "cjs",
  // The resolve shim maps dsh-subprocess-local's runner to Cairn's bundled
  // bootstrap beside main.js (electron/subprocess-runner.ts) — the package
  // itself is inlined, not shipped on disk. patchSubprocessRunnerEnv supplies
  // the Node-mode half.
  plugins: [patchSubprocessRunnerEnv, patchPtcRuntimeElectronEnv, patchWin32NoWindow],
  banner: {
    js: "globalThis.__cairnImportMetaUrl=require('url').pathToFileURL(__filename).href;globalThis.__cairnImportMetaResolve=(s)=>require('url').pathToFileURL(s==='@deepseek-ai/dsh-subprocess-local/runner'?require('path').join(__dirname,'subprocess-runner.cjs'):require.resolve(s)).href;",
  },
  define: {
    "import.meta.url": "globalThis.__cairnImportMetaUrl",
    // dsh-sandbox-local calls import.meta.resolve()
    // at runtime. esbuild stubs import.meta as {} in CJS output, so without
    // this every sandboxed command on Windows throws
    // "import_meta2.resolve is not a function". The primary fix is the
    // internals.windowsAclRunnerEntry override in cordis-coding-tools.ts
    // (avoids the call entirely); this shim is belt-and-braces for any other
    // current/future resolve() use. Only resolves shipped externals —
    // bundled dsh subpaths throw loudly instead of returning garbage.
    "import.meta.resolve": "globalThis.__cairnImportMetaResolve",
  },
};

const mcpServer = {
  entryPoints: ["electron/mcp-server.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  external: ["better-sqlite3", "ajv", "ajv-formats"],
  outfile: "dist-mcp/mcp-server.bundle.js",
  format: "cjs",
};

const embeddingsServer = {
  entryPoints: ["electron/embeddings/server.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  external: ["@huggingface/transformers", "onnxruntime-node"],
  outfile: "dist-electron/embeddings-server.bundle.js",
  format: "cjs",
};

const runtimeServer = {
  entryPoints: ["electron/runtime/server.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  external: ["@huggingface/transformers", "onnxruntime-node"],
  outfile: "dist-electron/runtime-server.bundle.js",
  format: "cjs",
};

// Windows sandbox runner (dsh-sandbox-windows-acl/lib/runner.js) as a real
// file next to main.js. dsh-sandbox-local locates it via
// import.meta.resolve() — broken in the CJS bundle AND unresolvable in the
// packaged app (dsh packages are inlined, not shipped on disk). Cairn pins
// this file via internals.windowsAclRunnerEntry (see cordis-coding-tools.ts)
// so the resolve() call is never reached. koffi stays external (shipped since
// #147); the runner requires it at runtime from app/node_modules.
// dsh spawns it as `[process.execPath, runner]`, which in Cairn is Electron.exe,
// so cordis-coding-tools.ts adds ELECTRON_RUN_AS_NODE=1 to that one spawn
// (without it every shell command booted a second Cairn instance). The banner
// drops it again before the runner spawns the sandboxed command, which
// inherits this process's environment block. Otherwise user commands like
// `electron .` would silently run as Node.
const windowsAclRunner = {
  entryPoints: ["node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js"],
  bundle: true,
  platform: "node",
  target: "node24",
  external: ["koffi"],
  plugins: [patchWin32NoWindow],
  // dsh ≥0.1.7 loads koffi through dsh-lazy-require's
  // createRequire(import.meta.url); without the shim esbuild stubs
  // import.meta.url to undefined in CJS and every Windows sandbox launch
  // would fail to load koffi.
  banner: { js: "delete process.env.ELECTRON_RUN_AS_NODE;globalThis.__cairnImportMetaUrl=require('url').pathToFileURL(__filename).href;" },
  define: { "import.meta.url": "globalThis.__cairnImportMetaUrl" },
  outfile: "dist-electron/windows-acl-runner.cjs",
  format: "cjs",
};

// PTC process bootstrap (dsh-ptc-runtime-node, mounted per coding turn in
// cordis-coding-tools.ts for dsh-workflow-ptc). The provider launches
// `new URL("./process.js", import.meta.url)`, which inside main.js means
// dist-electron/process.js, under ELECTRON_RUN_AS_NODE. The bootstrap only
// imports node: builtins (no top-level await), but bundle it so the file
// exists beside main.js.
const ptcProcess = {
  entryPoints: ["node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js"],
  bundle: true,
  platform: "node",
  target: "node24",
  outfile: "dist-electron/process.js",
  // Cairn's package.json has no "type": "module", so the launched .js runs as CJS.
  format: "cjs",
};

// dsh-subprocess-local containment runner bootstrap (see
// electron/subprocess-runner.ts). Runs under ELECTRON_RUN_AS_NODE; needs the
// import.meta.url shim because runner-launch computes a path from it at load.
const subprocessRunner = {
  entryPoints: ["electron/subprocess-runner.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  external: ["electron", "koffi"],
  outfile: "dist-electron/subprocess-runner.cjs",
  format: "cjs",
  plugins: [patchSubprocessRunnerEnv, patchWin32NoWindow],
  banner: mainPreload.banner,
  define: mainPreload.define,
};

async function main() {
  const electronConfigs = [mainPreload, windowsAclRunner, ptcProcess, subprocessRunner];
  const configs = electronOnly ? electronConfigs : [...electronConfigs, mcpServer, embeddingsServer, runtimeServer];
  if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("[compile-electron] watching for changes...");
  } else {
    for (const config of configs) {
      await esbuild.build(config);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
