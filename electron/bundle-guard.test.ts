/**
 * Bundle self-containment guard
 *
 * Ensures the esbuild output (dist-electron/main.js and
 * dist-electron/embeddings-server.bundle.js) does not contain any `require()`
 * calls for packages that aren't either:
 *   - Node.js built-ins (fs, path, crypto, node:*, …)
 *   - Allowlisted externals that ship separately or are otherwise tolerated
 *
 * Any other `require()` means esbuild left an import unresolved (because the
 * package was marked `--external` by mistake, or the import was dynamic and
 * esbuild couldn't see it). In a packaged Electron app there is no
 * `node_modules` to resolve from, so the app crashes at runtime with
 * "Cannot find module".
 *
 * This test was added after v2.1.4 shipped with `umap-js` marked
 * `--external` — the projection module required it at runtime and the
 * packaged app crashed on launch.
 *
 * The drift checks below additionally guard against the inverse mistake:
 * declaring `--external:foo` in package.json but never shipping `foo` in
 * electron-builder.yml. Each allowlisted external is classified so the test
 * knows exactly where it is allowed to appear.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");

const BUNDLES = [
  "dist-electron/main.js",
  "dist-electron/embeddings-server.bundle.js",
  "dist-electron/runtime-server.bundle.js",
] as const;

/* ──────────────────────────────────────────────────────────────────────── *
 * Allowlist classification
 *
 * Every entry must be in exactly one group below. The groups drive both the
 * "no un-allowed requires" test and the "is it actually shipped?" drift test.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Provided by the Electron runtime itself — never needs shipping.
 */
const RUNTIME_PROVIDED = new Set([
  "electron",
]);

/**
 * Transitive deps of bundled libraries (e.g. gray-matter → js-yaml → esprima,
 * ws → bufferutil/utf-8-validate) that the source code wraps in
 * `try { require(...) } catch {}` so their absence is non-fatal. These never
 * need to ship.
 */
const OPTIONAL_TRANSITIVE = new Set([
  "esprima",
  // ws optional native accelerators — guarded requires, non-fatal when absent.
  "bufferutil",
  "utf-8-validate",
]);

/**
 * Used by the unified runtime server subprocess, which runs as an
 * ELECTRON_RUN_AS_NODE child of Electron. These packages MUST be shipped
 * via electron-builder.yml because the runtime-server resolves them from
 * the app's node_modules at runtime. They must NOT appear in the Electron
 * main bundle requires (main.js) — only in runtime-server.bundle.js.
 */
const RUNTIME_SHIPPED = new Set([
  "@huggingface/transformers",
  "onnxruntime-node",
]);

/**
 * Native runtime modules — MUST be shipped via electron-builder.yml `files`
 * and `asarUnpack` so the packaged app can load them.
 */
const SHIPPED_NATIVE = new Set([
  "better-sqlite3",
  "node-pty",
  // koffi (native FFI, pulled in transitively by dsh-fs-local,
  // dsh-session-persistence-jsonl, dsh-subprocess-local, …) resolves its
  // prebuilt binary at runtime relative to its own package dir
  // (node_modules/koffi + node_modules/@koromix/koffi-<platform>-<arch>).
  // Bundling it inlines that lookup into main.js with a broken dirname, so
  // it stays external like the other natives. Its platform binaries ship
  // via electron-builder.yml (`node_modules/koffi` + `node_modules/@koromix`).
  "koffi",
]);

/**
 * The MCP SDK's default JSON-schema validator pulls in `ajv` (+ `ajv-formats`).
 * ajv generates validation code that `require()`s its own runtime helpers via
 * computed paths esbuild can't statically inline, so ajv is marked `--external`
 * for the main bundle and shipped (with its transitive deps) via
 * electron-builder.yml. Pure JS — no native binaries.
 */
const MCP_SDK_SHIPPED = new Set([
  "ajv",
  "ajv-formats",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-traverse",
  "require-from-string",
]);

/**
 * The full allowlist. Union of the groups above. Any `require()` in any
 * bundle that isn't in this set (or a Node built-in) fails the test.
 */
const ALLOWED_EXTERNALS = new Set<string>([
  ...RUNTIME_PROVIDED,
  ...OPTIONAL_TRANSITIVE,
  ...RUNTIME_SHIPPED,
  ...SHIPPED_NATIVE,
  ...MCP_SDK_SHIPPED,
]);

/* ──────────────────────────────────────────────────────────────────────── *
 * Node.js built-in module names (with and without the "node:" prefix).
 * Generated from the Node 22 module list.
 * ──────────────────────────────────────────────────────────────────────── */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "fs/promises", "http", "http2", "https", "inspector",
  "module", "net", "os", "path", "perf_hooks", "process", "punycode",
  "querystring", "readline", "repl", "stream", "string_decoder", "sys",
  "test", "timers", "tls", "trace_events", "tty", "url", "util", "v8",
  "vm", "wasi", "worker_threads", "zlib",
  // node: prefixed variants
  "node:assert", "node:async_hooks", "node:buffer", "node:child_process",
  "node:cluster", "node:console", "node:constants", "node:crypto",
  "node:dgram", "node:diagnostics_channel", "node:dns", "node:domain",
  "node:events", "node:fs", "node:fs/promises", "node:http", "node:http2",
  "node:https", "node:inspector", "node:module", "node:net", "node:os",
  "node:path", "node:perf_hooks", "node:process", "node:punycode",
  "node:querystring", "node:readline", "node:repl", "node:stream",
  "node:string_decoder", "node:sys", "node:test", "node:timers",
  "node:tls", "node:trace_events", "node:tty", "node:url", "node:util",
  "node:v8", "node:vm", "node:wasi", "node:worker_threads", "node:zlib",
  // Node 22 stream/util subpath builtins (used via the node: prefix).
  "node:stream/promises", "node:stream/web", "node:util/types",
  "node:timers/promises",
  // node:dns/promises (undici, via dsh-web-fetch-http) — universal builtin.
  "node:dns/promises",
  // node:sqlite (dsh-session-query-sqlite, dynamic import; undici's guarded
  // feature probe). Stable unflagged since Node 22.13 — Electron 43 bundles
  // Node 24 (verified via ELECTRON_RUN_AS_NODE). Revisit if Electron ever
  // downgrades Node below 22.13.
  "node:sqlite",
]);

/* ──────────────────────────────────────────────────────────────────────── *
 * Parsing helpers
 * ──────────────────────────────────────────────────────────────────────── */

/** Regex to find `require("...")` calls in CJS bundle output. */
const REQUIRE_RE = /require\("([^"]+)"\)/g;

/**
 * Reduce a require specifier to its package name so subpath imports
 * (`ajv/dist/runtime/uri`) match the bare package allowlist entry (`ajv`).
 * Scoped packages keep their first two segments (`@scope/name`). Node built-ins
 * and relative paths are returned unchanged.
 */
function packageNameOf(spec: string): string {
  if (spec.startsWith(".") || spec.startsWith("/")) return spec;
  const parts = spec.split("/");
  if (spec.startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0];
}

function extractRequires(bundlePath: string): string[] {
  const src = fs.readFileSync(bundlePath, "utf8");
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = REQUIRE_RE.exec(src)) !== null) {
    matches.push(m[1]);
  }
  return [...new Set(matches)];
}

/**
 * Parse all externals esbuild is told to leave external.
 * Legacy: `--external:<pkg>` flags from the `compile` script in package.json.
 * Current: the `external: [...]` array in scripts/compile-electron.js (the
 * esbuild JS API build — no shell flags involved). Both are collected so the
 * drift check stays meaningful across the migration.
 * Returns the set of package names that esbuild leaves external.
 */
function parseEsbuildExternals(): Set<string> {
  const out = new Set<string>();
  const pkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const compileCmd = pkg.scripts?.compile ?? "";
  const re = /--external:([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(compileCmd)) !== null) out.add(m[1]);
  // scripts/compile-electron.js — `external: [ "electron", "koffi", … ]`.
  // Quoted strings inside an `external:` array literal.
  try {
    const compileJs = fs.readFileSync(
      path.join(ROOT, "scripts", "compile-electron.js"),
      "utf8",
    );
    const extRe = /external\s*:\s*\[([\s\S]*?)\]/g;
    let em: RegExpExecArray | null;
    while ((em = extRe.exec(compileJs)) !== null) {
      // Strip line + block comments — they may contain quoted strings
      // (e.g. "Cannot find the native Koffi module") that aren't externals.
      const code = em[1]
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const strRe = /["']([^"']+)["']/g;
      let sm: RegExpExecArray | null;
      while ((sm = strRe.exec(code)) !== null) out.add(sm[1]);
    }
  } catch {
    // compile script missing — package.json flags alone are the source.
  }
  return out;
}

/**
 * Parse the names of packages that electron-builder.yml actually ships from
 * `node_modules/` — i.e. all `node_modules/<pkg>` paths in `files:` and
 * `asarUnpack:`, ignoring negation patterns. Handles scoped packages
 * (`@scope/name`) in addition to bare names (`better-sqlite3`), plus
 * scope-wide globs (`node_modules/@koromix/**`) which ship every package
 * under that scope (used for koffi's per-platform `@koromix/koffi-*`
 * binaries).
 */
function parseShippedPackages(): Set<string> {
  const ymlPath = path.join(ROOT, "electron-builder.yml");
  const yml = fs.readFileSync(ymlPath, "utf8");
  // Match either @scope/name or plain name after `node_modules/`.
  // Stop at `/`, `*`, `!`, whitespace, or end of token.
  const re = /node_modules\/(@[a-z0-9_-]+\/[a-z0-9_-]+|[a-z0-9_-]+)/gi;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(yml)) !== null) out.add(m[1]);
  // Scope-wide globs: `node_modules/@<scope>/**/*` ships the whole scope.
  // Expand to every allowlisted package under that scope so drift checks
  // don't demand one yml line per platform binary.
  const scopeRe = /node_modules\/(@[a-z0-9_-]+)\/\*\*/gi;
  let sm: RegExpExecArray | null;
  while ((sm = scopeRe.exec(yml)) !== null) {
    const scope = sm[1];
    for (const pkg of ALLOWED_EXTERNALS) {
      if (pkg.startsWith(`${scope}/`)) out.add(pkg);
    }
    // koffi's binaries live under @koromix but are resolved via an absolute
    // path built at runtime (not a bare `require()`), so they never appear
    // in ALLOWED_EXTERNALS — mark the scope itself as shipped so the
    // SHIPPED_NATIVE check below can accept them.
    out.add(`${scope}/*`);
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────── *
 * Tests
 * ──────────────────────────────────────────────────────────────────────── */

describe("bundle self-containment guard", () => {
  for (const bundleRel of BUNDLES) {
    const bundlePath = path.join(ROOT, bundleRel);

    describe(bundleRel, () => {
      it.skipIf(!fs.existsSync(bundlePath))("bundle exists (run `npm run compile` first)", async () => {
        // No-op — skipIf handles the existence check. The real test below
        // does the work when the bundle is present.
      });

      it("no un-allowed external requires", () => {
        if (!fs.existsSync(bundlePath)) return;
        const requires = extractRequires(bundlePath);
        const offenders = requires.filter((r) => {
          const pkg = packageNameOf(r);
          return !NODE_BUILTINS.has(r) && !ALLOWED_EXTERNALS.has(pkg);
        });
        expect(
          offenders,
          `Bundle ${bundleRel} contains \`require()\` calls for packages that are neither Node built-ins nor on the ALLOWED_EXTERNALS list. In a packaged Electron app these will fail with "Cannot find module". Either remove the package from \`external\` in scripts/compile-electron.js (so esbuild bundles it), or add the package to ALLOWED_EXTERNALS and ship it via electron-builder.yml.\n  Offenders:\n    - ${offenders.join("\n    - ")}`,
        ).toHaveLength(0);
      });
    });
  }
});

describe("import.meta stub guards (esbuild CJS breaks ESM import.meta.*)", () => {
  const mainBundle = path.join(ROOT, "dist-electron/main.js");

  it("no unshimmed import.meta.resolve in the main bundle", () => {
    if (!fs.existsSync(mainBundle)) return;
    const src = fs.readFileSync(mainBundle, "utf8");
    // esbuild rewrites `import.meta.X` to `import_meta.X` / `import_meta2.X`
    // stubs ({}). The banner+define in scripts/compile-electron.js replaces
    // import.meta.url and import.meta.resolve with globals — any remaining
    // stubbed `.resolve(` access throws "…resolve is not a function" at
    // runtime (broke every sandboxed command on Windows via dsh-sandbox-local).
    const offenders = src.match(/import_meta\d*\.resolve\s*\(/g) ?? [];
    expect(
      offenders,
      `dist-electron/main.js calls a stubbed import.meta.resolve (${offenders.length}x). Add a define+banner shim in scripts/compile-electron.js (scripts/build.js reuses it via --electron-only).`,
    ).toHaveLength(0);
  });

  it("windows sandbox runner ships beside the bundle", () => {
    // dsh-sandbox-local's Windows ACL runner is pinned via
    // internals.windowsAclRunnerEntry (cordis-coding-tools.ts) — the file
    // must exist in dist-electron/ (covered by the existing
    // `dist-electron/**/*` ship glob in electron-builder.yml).
    if (!fs.existsSync(mainBundle)) return;
    expect(
      fs.existsSync(path.join(ROOT, "dist-electron/windows-acl-runner.cjs")),
      "dist-electron/windows-acl-runner.cjs missing — run `npm run compile` (scripts/compile-electron.js builds it from dsh-sandbox-windows-acl).",
    ).toBe(true);
  });

  it("subprocess containment runner ships and is launched in Node mode", () => {
    // dsh-subprocess-local spawns `[process.execPath, runner]` — Electron.exe
    // in Cairn. The resolve shim points at the bundled bootstrap and the
    // patchSubprocessRunnerEnv plugin adds ELECTRON_RUN_AS_NODE to the
    // runner's env; without both, every agent subprocess boots a second app.
    if (!fs.existsSync(mainBundle)) return;
    const src = fs.readFileSync(mainBundle, "utf8");
    expect(fs.existsSync(path.join(ROOT, "dist-electron/subprocess-runner.cjs")), "dist-electron/subprocess-runner.cjs missing — run `npm run compile`.").toBe(true);
    expect(src, "resolve shim no longer maps the dsh-subprocess-local runner to subprocess-runner.cjs").toContain("'subprocess-runner.cjs'");
    expect(src, "patchSubprocessRunnerEnv did not apply — runnerEnvironment lacks ELECTRON_RUN_AS_NODE").toMatch(/\[SUBPROCESS_RUNNER_ENV\]: selection,\s*\.\.\.\(?process\.versions\.electron \? \{ ELECTRON_RUN_AS_NODE: "1" \}/);
  });

  it("workflow worker ships beside the bundle", () => {
    // dsh-workflow-worker-thread loads new URL("./worker.cjs", import.meta.url).
    if (!fs.existsSync(mainBundle)) return;
    expect(fs.existsSync(path.join(ROOT, "dist-electron/worker.cjs")), "dist-electron/worker.cjs missing — run `npm run compile`.").toBe(true);
  });
});

describe("allowlist drift checks", () => {
  const esbuildExternals = parseEsbuildExternals();
  const shipped = parseShippedPackages();

  it("every esbuild external (compile-electron.js + package.json flags) is in ALLOWED_EXTERNALS", () => {
    const drift = [...esbuildExternals].filter((x) => !ALLOWED_EXTERNALS.has(x));
    expect(
      drift,
      "scripts/compile-electron.js `external: [...]` (or package.json `compile` `--external:<pkg>`) declares <pkg> but it isn't in any allowlist group in bundle-guard.test.ts. Either add the package to the appropriate group (RUNTIME_PROVIDED / OPTIONAL_TRANSITIVE / RUNTIME_SHIPPED / SHIPPED_NATIVE / MCP_SDK_SHIPPED) or remove the external (and let esbuild bundle it in).\n  Untracked externals:\n    - " + drift.join("\n    - "),
    ).toHaveLength(0);
  });

  it("koffi native binaries ship via electron-builder.yml (koffi + @koromix scope)", () => {
    // koffi's prebuilt .node files live in @koromix/koffi-<platform>-<arch>
    // and are resolved via an absolute path at runtime — invisible to the
    // `require()` scan. Without the scope-wide glob the packaged app throws
    // "Cannot find the native Koffi module" on first session flush.
    const missing: string[] = [];
    if (!shipped.has("koffi")) missing.push("koffi (node_modules/koffi/**/*)");
    if (!shipped.has("@koromix/*"))
      missing.push("@koromix/* (node_modules/@koromix/**/*)");
    expect(
      missing,
      "koffi is external but its runtime files don't ship. Add `node_modules/koffi/**/*` and `node_modules/@koromix/**/*` to electron-builder.yml `files` + `asarUnpack` and the negation-glob allowlist.\n  Missing:\n    - " +
        missing.join("\n    - "),
    ).toHaveLength(0);
  });

  it("every SHIPPED_NATIVE external actually ships via electron-builder.yml", () => {
    const missing = [...SHIPPED_NATIVE].filter((x) => !shipped.has(x));
    expect(
      missing,
      "ALLOWED_EXTERNALS lists these as SHIPPED_NATIVE (so they must be in node_modules when the Electron app is packaged) but electron-builder.yml \`files\`/\`asarUnpack\` doesn't include them. Add a \`node_modules/<pkg>/**/*\` entry.\n  Missing:\n    - " + missing.join("\n    - "),
    ).toHaveLength(0);
  });

  it("every RUNTIME_SHIPPED external ships via electron-builder.yml", () => {
    const missing = [...RUNTIME_SHIPPED].filter((x) => !shipped.has(x));
    expect(
      missing,
      "These are classified RUNTIME_SHIPPED (used by the runtime-server subprocess which runs as ELECTRON_RUN_AS_NODE) but electron-builder.yml `files`/`asarUnpack` doesn't include them. Add a `node_modules/<pkg>/**/*` entry.\n  Missing:\n    - " + missing.join("\n    - "),
    ).toHaveLength(0);
  });

  it("every MCP_SDK_SHIPPED external actually ships via electron-builder.yml", () => {
    const missing = [...MCP_SDK_SHIPPED].filter((x) => !shipped.has(x));
    expect(
      missing,
      "These are classified MCP_SDK_SHIPPED (ajv + transitive deps for the MCP SDK validator, marked --external in the main bundle) but electron-builder.yml `files` doesn't include them. Add a `node_modules/<pkg>/**/*` entry and update the negation glob.\n  Missing:\n    - " + missing.join("\n    - "),
    ).toHaveLength(0);
  });

  it("RUNTIME_SHIPPED externals never appear in the Electron main bundle requires", () => {
    const mainPath = path.join(ROOT, "dist-electron/main.js");
    if (!fs.existsSync(mainPath)) return;
    const mainReqs = new Set(extractRequires(mainPath));
    const leaks = [...RUNTIME_SHIPPED].filter((x) => mainReqs.has(x));
    expect(
      leaks,
      "dist-electron/main.js `require()`s a package marked RUNTIME_SHIPPED. These packages are only for the runtime-server subprocess — the main bundle must not import them directly. If a main-bundle module genuinely needs them, reclassify as SHIPPED_NATIVE and verify they ship in electron-builder.yml.\n  Leaks:\n    - " + leaks.join("\n    - "),
    ).toHaveLength(0);
  });

  it("no allowlisted external is silently duplicated across groups", () => {
    const groups = [
      ["RUNTIME_PROVIDED", RUNTIME_PROVIDED],
      ["OPTIONAL_TRANSITIVE", OPTIONAL_TRANSITIVE],
      ["RUNTIME_SHIPPED", RUNTIME_SHIPPED],
      ["SHIPPED_NATIVE", SHIPPED_NATIVE],
      ["MCP_SDK_SHIPPED", MCP_SDK_SHIPPED],
    ] as const;
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [name, set] of groups) {
      for (const pkg of set) {
        if (seen.has(pkg)) dupes.push(`${pkg} (${seen.get(pkg)} + ${name})`);
        else seen.set(pkg, name);
      }
    }
    expect(
      dupes,
      "An allowlisted external appears in more than one group — pick the one that most accurately describes its lifecycle and delete the rest.\n  Duplicates:\n    - " + dupes.join("\n    - "),
    ).toHaveLength(0);
  });
});
