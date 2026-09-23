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

const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

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
  outdir: "dist-electron",
  format: "cjs",
  banner: {
    js: "globalThis.__cairnImportMetaUrl=require('url').pathToFileURL(__filename).href;globalThis.__cairnImportMetaResolve=(s)=>require('url').pathToFileURL(require.resolve(s)).href;",
  },
  define: {
    "import.meta.url": "globalThis.__cairnImportMetaUrl",
    // dsh-sandbox-local + dsh-workflow-worker-thread call import.meta.resolve()
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
  banner: { js: "delete process.env.ELECTRON_RUN_AS_NODE;" },
  outfile: "dist-electron/windows-acl-runner.cjs",
  format: "cjs",
};

async function main() {
  const configs = [mainPreload, mcpServer, embeddingsServer, runtimeServer, windowsAclRunner];
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
