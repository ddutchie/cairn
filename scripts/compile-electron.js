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
  ],
  outdir: "dist-electron",
  format: "cjs",
  banner: {
    js: "globalThis.__cairnImportMetaUrl=require('url').pathToFileURL(__filename).href;",
  },
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
  const configs = [mainPreload, mcpServer, embeddingsServer, runtimeServer];
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
