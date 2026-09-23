/**
 * Runtime-lookup guard for bundled dependencies.
 *
 * Cairn bundles dsh (and friends) into dist-electron/ and runs it inside the
 * Electron main process. That breaks code that finds files, packages or
 * executables relative to itself at runtime, or that spawns
 * `process.execPath` assuming it's Node. Those caused the sandbox-runner,
 * subprocess-runner, ripgrep and workflow-worker bugs in 3.0.9 — see
 * docs/plans/electron-host-runtime.md. Upstream runs dsh unbundled under
 * ELECTRON_RUN_AS_NODE, so its own tests never exercise this.
 *
 * Every such site inside node_modules code must be listed in
 * REVIEWED_RUNTIME_LOOKUPS with how it's handled, so a dsh upgrade that adds
 * one fails here instead of in users' hands. Requires `npm run compile`
 * (skips when the bundles are absent, like bundle-guard.test.ts).
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");

const LOOKUP_BUNDLES = [
  "dist-electron/main.js",
  "dist-electron/worker.cjs",
  "dist-electron/subprocess-runner.cjs",
  "dist-electron/windows-acl-runner.cjs",
];

const LOOKUP_PATTERNS: Record<string, RegExp> = {
  // Spawning the host executable assumes it's Node; in Cairn it's Electron.
  execPath: /process\.execPath/,
  // import.meta.resolve (via the banner shim) — only shipped externals resolve.
  importMetaResolve: /__cairnImportMetaResolve\(/,
  // new URL("./x", import.meta.url) — a file beside the ORIGINAL module.
  urlFromImportMeta: /new URL\([^;]*?__cairnImportMetaUrl/,
  // createRequire(...) — resolves packages/files that may not ship.
  createRequire: /createRequire\)?\(/,
  requireResolve: /require\.resolve\(/,
  // Worker threads load a file by path.
  worker: /new (?:import_[\w$]+\.)?Worker\(/,
  // import.meta.* that esbuild stubbed to {} (dirname, filename, main, …).
  importMetaStub: /\bimport_meta\d*\.\w+/,
};

const PLAN = "docs/plans/electron-host-runtime.md";

/** `<pattern> <bundle> <module>` → how the site is handled. */
const REVIEWED_RUNTIME_LOOKUPS: Record<string, string> = {
  // ── dist-electron/main.js ──────────────────────────────────────────────
  "createRequire dist-electron/main.js node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js":
    "requireInternal() — only used when --expose-internals is passed, which Cairn doesn't.",
  "createRequire dist-electron/main.js node_modules/@deepseek-ai/dsh-llm/lib/index.js":
    "Reads ../package.json for APP_IDENTITY.version; resolves to Cairn's package.json when bundled, so it reports Cairn's version. Harmless.",
  "createRequire dist-electron/main.js node_modules/@deepseek-ai/node-addon-system/lib/flock.js":
    `POSIX session lock (dsh-session-persistence-jsonl) needs @deepseek-ai/node-addon-system-<platform>-<arch> shipped on macOS/Linux. OPEN — ${PLAN}.`,
  "createRequire dist-electron/main.js node_modules/@deepseek-ai/node-addon-system/lib/index.js":
    `Linux Landlock launcher path (dsh-sandbox-local). OPEN — ${PLAN}.`,
  "createRequire dist-electron/main.js node_modules/fflate/esm/index.mjs":
    "Probes the worker_threads builtin only.",
  "execPath dist-electron/main.js node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js":
    "Windows ACL runner spawn — entry pinned and ELECTRON_RUN_AS_NODE added by runWindowsAclRunnerAsNode (cordis-coding-tools.ts).",
  "execPath dist-electron/main.js node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner-launch-*.js":
    "Containment runner spawn — shim maps it to subprocess-runner.cjs; patchSubprocessRunnerEnv adds ELECTRON_RUN_AS_NODE (compile-electron.js).",
  "execPath dist-electron/main.js node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js":
    "pkg `-rg` sidecar check, gated on `\"pkg\" in process`; ripgrep comes from electron/lib/ripgrep-path.ts.",
  "importMetaResolve dist-electron/main.js node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js":
    "Windows ACL runner lookup — skipped because internals.windowsAclRunnerEntry is pinned; the source fallback is dev-only.",
  "importMetaResolve dist-electron/main.js node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js":
    "tsx bootstrap for the verification worker — only when running from .ts source.",
  "importMetaResolve dist-electron/main.js node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner-launch-*.js":
    "Runner entry — shim maps it to dist-electron/subprocess-runner.cjs; the tsx branch is dev-only.",
  "importMetaResolve dist-electron/main.js node_modules/@deepseek-ai/dsh-workflow-worker-thread/lib/index.js":
    "tsx bootstrap for the workflow worker — only when running from .ts source.",
  "urlFromImportMeta dist-electron/main.js node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js":
    "worker.cjs for verifyCurrentGenerationInWorker — never called (dead code); plus the .ts-source branch.",
  "urlFromImportMeta dist-electron/main.js node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner-launch-*.js":
    "SOURCE_TSCONFIG_PATH and bin.ts — used only by the .ts-source runner branch.",
  "urlFromImportMeta dist-electron/main.js node_modules/@deepseek-ai/dsh-workflow-worker-thread/lib/index.js":
    "./worker.cjs — built to dist-electron/worker.cjs by compile-electron.js.",
  "urlFromImportMeta dist-electron/main.js node_modules/@deepseek-ai/node-addon-system/lib/index.js":
    `Landlock launcher fallback path (Linux). OPEN — ${PLAN}.`,
  "worker dist-electron/main.js node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js":
    "Verification worker — never called (dead code).",
  "worker dist-electron/main.js node_modules/@deepseek-ai/dsh-workflow-worker-thread/lib/index.js":
    "Workflow worker — dist-electron/worker.cjs.",
  // ── dist-electron/worker.cjs ───────────────────────────────────────────
  "createRequire dist-electron/worker.cjs node_modules/@deepseek-ai/dsh-llm/lib/index.js":
    "Same as main.js: reads ../package.json for the version. Harmless.",
  // ── dist-electron/subprocess-runner.cjs ────────────────────────────────
  "importMetaStub dist-electron/subprocess-runner.cjs node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner.js":
    "import.meta.main auto-run guard, intentionally inert; electron/subprocess-runner.ts calls runSelectedSubprocessRunner.",
  "urlFromImportMeta dist-electron/subprocess-runner.cjs node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner-launch-*.js":
    "SOURCE_TSCONFIG_PATH computed at load; the banner shim keeps import.meta.url valid and the value is only used from .ts source.",
};

/** Hits inside node_modules code, keyed `<pattern> <bundle> <module>`. */
function scanRuntimeLookups(): Set<string> {
  const hits = new Set<string>();
  for (const rel of LOOKUP_BUNDLES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    let mod: string | undefined;
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      // esbuild marks each inlined module with a `// <path>` comment.
      const marker = /^\/\/ ((?:node_modules|electron|src|shared)\/\S+)$/.exec(line);
      if (marker) {
        // Normalize content-hashed chunk names (runner-launch-COYGu0Dl.js).
        mod = marker[1].replace(/-[A-Za-z0-9_]{8}\.js$/, "-*.js");
        continue;
      }
      if (!mod?.startsWith("node_modules/")) continue;
      for (const [name, re] of Object.entries(LOOKUP_PATTERNS)) {
        if (re.test(line)) hits.add(`${name} ${rel} ${mod}`);
      }
    }
  }
  return hits;
}

const allBuilt = LOOKUP_BUNDLES.every((b) => fs.existsSync(path.join(ROOT, b)));

describe("runtime lookups in bundled dependencies", () => {
  it("every runtime file/binary lookup in node_modules code is reviewed", () => {
    if (!allBuilt) return;
    const unreviewed = [...scanRuntimeLookups()].filter((k) => !(k in REVIEWED_RUNTIME_LOOKUPS)).sort();
    expect(
      unreviewed,
      "A bundled dependency (usually a dsh upgrade) added a runtime lookup that bundling can break: spawning process.execPath (Electron, not Node, in Cairn), import.meta.resolve / new URL(…, import.meta.url) / createRequire (resolve relative to the ORIGINAL module, which isn't on disk once bundled), or a worker file. " +
        `Check the target ships beside the bundle and runs under Electron, fix it (patterns used so far: ${PLAN}), then add the key to REVIEWED_RUNTIME_LOOKUPS with how it's handled.\n  Unreviewed:\n    - ` +
        unreviewed.join("\n    - "),
    ).toHaveLength(0);
  });

  it("REVIEWED_RUNTIME_LOOKUPS has no stale entries", () => {
    if (!allBuilt) return;
    const hits = scanRuntimeLookups();
    const stale = Object.keys(REVIEWED_RUNTIME_LOOKUPS).filter((k) => !hits.has(k)).sort();
    expect(
      stale,
      "These reviewed lookups no longer appear in the bundles (the dependency changed or the site moved). Re-check the new code, then update or remove the entry.\n  Stale:\n    - " +
        stale.join("\n    - "),
    ).toHaveLength(0);
  });
});
