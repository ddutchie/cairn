/**
 * Bundle self-containment guard
 *
 * Ensures the esbuild output (dist-electron/main.js and
 * dist-electron/embeddings-server.bundle.js) does not contain any `require()`
 * calls for packages that aren't either:
 *   - Node.js built-ins (fs, path, crypto, node:*, …)
 *   - Allowlisted externals that ship separately (electron, better-sqlite3,
 *     node-pty, @huggingface/transformers, onnxruntime-node)
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
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");

const BUNDLES = [
  "dist-electron/main.js",
  "dist-electron/embeddings-server.bundle.js",
];

/**
 * Packages that esbuild is intentionally told to leave external.
 * They must be shipped separately via electron-builder.yml or be Node built-ins.
 */
const ALLOWED_EXTERNALS = new Set([
  // Native runtime modules — shipped via electron-builder "files" + asarUnpack
  "better-sqlite3",
  "node-pty",
  // Electron itself — provided by the runtime
  "electron",
  // Heavy runtime deps — kept external so they don't bloat the bundle;
  //   resolve from node_modules at runtime in dev, and from app.asar in prod
  "@huggingface/transformers",
  "onnxruntime-node",
  // Optional transitive dep of js-yaml (via gray-matter) — wrapped in
  // try/catch in source, so its absence is non-fatal.
  "esprima",
]);

/**
 * Node.js built-in module names (with and without the "node:" prefix).
 * Generated from the Node 22 module list.
 */
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
