/**
 * scripts/compile-electron.js
 *
 * Builds the Electron main/preload bundle plus the MCP/embeddings/runtime
 * sidecar bundles via esbuild's Node API instead of the CLI.
 *
 * Using the JS API instead of the CLI keeps shell quoting (npm on Windows goes
 * through two shells) out of the picture.
 *
 * Usage: node scripts/compile-electron.js [--watch]
 */

const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");
// Main/preload only. scripts/build.js uses this so release builds get the same shims as dev.
const electronOnly = process.argv.includes("--electron-only");

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
  ],
  // glob/grep spawn @vscode/ripgrep's rgPath, which points inside app.asar
  // when packaged — the shim redirects it to the unpacked binary.
  alias: { "@vscode/ripgrep": "./electron/lib/ripgrep-path.ts" },
  outdir: "dist-electron",
  format: "cjs",
  // esbuild stubs import.meta as {} in CJS output; code that builds a require
  // from import.meta.url (electron/lib/pty-sessions.ts) gets the bundle's own URL instead.
  banner: { js: "globalThis.__cairnImportMetaUrl=require('url').pathToFileURL(__filename).href;" },
  define: { "import.meta.url": "globalThis.__cairnImportMetaUrl" },
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

async function main() {
  const electronConfigs = [mainPreload];
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
