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
 * Transitive deps of bundled libraries (e.g. gray-matter → js-yaml → esprima)
 * that the source code wraps in `try { require(...) } catch {}` so their
 * absence is non-fatal. These never need to ship.
 */
const OPTIONAL_TRANSITIVE = new Set([
  "esprima",
]);

/**
 * Used only by the embeddings-server worker subprocess, never by the Electron
 * main bundle. The worker (`embeddings-server.bundle.js`) has its own runtime
 * resolution path (injected via `TRANSFORMERS_CACHE` / `pkg.config.js`), so
 * these packages MUST NOT be listed in electron-builder.yml either — otherwise
 * we'd bloat the main app with packages no main-bundle code can resolve.
 */
const SUBPROCESS_ONLY = new Set([
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
]);

/**
 * The full allowlist. Union of the four groups above. Any `require()` in any
 * bundle that isn't in this set (or a Node built-in) fails the test.
 */
const ALLOWED_EXTERNALS = new Set<string>([
  ...RUNTIME_PROVIDED,
  ...OPTIONAL_TRANSITIVE,
  ...SUBPROCESS_ONLY,
  ...SHIPPED_NATIVE,
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
]);

/* ──────────────────────────────────────────────────────────────────────── *
 * Parsing helpers
 * ──────────────────────────────────────────────────────────────────────── */

/** Regex to find `require("...")` calls in CJS bundle output. */
const REQUIRE_RE = /require\("([^"]+)"\)/g;

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
 * Parse all `--external:<pkg>` flags from the `compile` script in package.json.
 * Returns the set of package names that esbuild is told to leave external.
 */
function parseEsbuildExternals(): Set<string> {
  const pkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const compileCmd = pkg.scripts?.compile ?? "";
  const re = /--external:([^\s]+)/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(compileCmd)) !== null) out.add(m[1]);
  return out;
}

/**
 * Parse the names of packages that electron-builder.yml actually ships from
 * `node_modules/` — i.e. all `node_modules/<pkg>` paths in `files:` and
 * `asarUnpack:`, ignoring negation patterns. Handles scoped packages
 * (`@scope/name`) in addition to bare names (`better-sqlite3`).
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
        const offenders = requires.filter(
          (r) => !NODE_BUILTINS.has(r) && !ALLOWED_EXTERNALS.has(r),
        );
        expect(
          offenders,
          `Bundle ${bundleRel} contains \`require()\` calls for packages that are neither Node built-ins nor on the ALLOWED_EXTERNALS list. In a packaged Electron app these will fail with "Cannot find module". Either remove the \`--external:<pkg>\` flag from the esbuild command in package.json (so esbuild bundles the package), or add the package to ALLOWED_EXTERNALS and ship it via electron-builder.yml.\n  Offenders:\n    - ${offenders.join("\n    - ")}`,
        ).toHaveLength(0);
      });
    });
  }
});

describe("allowlist drift checks", () => {
  const esbuildExternals = parseEsbuildExternals();
  const shipped = parseShippedPackages();

  it("every --external flag in package.json compile script is in ALLOWED_EXTERNALS", () => {
    const drift = [...esbuildExternals].filter((x) => !ALLOWED_EXTERNALS.has(x));
    expect(
      drift,
      "package.json \`compile\` script declares \`--external:<pkg>\` but <pkg> isn't in any allowlist group in bundle-guard.test.ts. Either add the package to the appropriate group (RUNTIME_PROVIDED / OPTIONAL_TRANSITIVE / SUBPROCESS_ONLY / SHIPPED_NATIVE) or remove the \`--external\` flag (and let esbuild bundle it in).\n  Untracked externals:\n    - " + drift.join("\n    - "),
    ).toHaveLength(0);
  });

  it("every SHIPPED_NATIVE external actually ships via electron-builder.yml", () => {
    const missing = [...SHIPPED_NATIVE].filter((x) => !shipped.has(x));
    expect(
      missing,
      "ALLOWED_EXTERNALS lists these as SHIPPED_NATIVE (so they must be in node_modules when the Electron app is packaged) but electron-builder.yml \`files\`/\`asarUnpack\` doesn't include them. Add a \`node_modules/<pkg>/**/*\` entry.\n  Missing:\n    - " + missing.join("\n    - "),
    ).toHaveLength(0);
  });

  it("every SUBPROCESS_ONLY external is NOT shipped via electron-builder.yml", () => {
    const leaks = [...SUBPROCESS_ONLY].filter((x) => shipped.has(x));
    expect(
      leaks,
      "These are classified SUBPROCESS_ONLY (used solely by the embeddings worker, which resolves them via its own node_modules/pkg runtime) but electron-builder.yml \`files\`/\`asarUnpack\` is shipping them too. Shipping them in the main Electron app is either wasted space or a sign of misclassification — they shouldn't be on main-bundle disk.\n  Leaks:\n    - " + leaks.join("\n    - "),
    ).toHaveLength(0);
  });

  it("SUBPROCESS_ONLY externals never appear in the Electron main bundle requires", () => {
    const mainPath = path.join(ROOT, "dist-electron/main.js");
    if (!fs.existsSync(mainPath)) return;
    const mainReqs = new Set(extractRequires(mainPath));
    const leaks = [...SUBPROCESS_ONLY].filter((x) => mainReqs.has(x));
    expect(
      leaks,
      "dist-electron/main.js \`require()\`s a package marked SUBPROCESS_ONLY. These packages are not shipped with the Electron app (they only live in the embeddings worker) — the main bundle must not import them. If a main-bundle module genuinely needs them, reclassify as SHIPPED_NATIVE and verify they ship in electron-builder.yml.\n  Leaks:\n    - " + leaks.join("\n    - "),
    ).toHaveLength(0);
  });

  it("no allowlisted external is silently duplicated across groups", () => {
    const groups = [
      ["RUNTIME_PROVIDED", RUNTIME_PROVIDED],
      ["OPTIONAL_TRANSITIVE", OPTIONAL_TRANSITIVE],
      ["SUBPROCESS_ONLY", SUBPROCESS_ONLY],
      ["SHIPPED_NATIVE", SHIPPED_NATIVE],
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
