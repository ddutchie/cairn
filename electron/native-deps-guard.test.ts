/**
 * Native-deps guard — prevents the Windows arm64 (or any platform) build from
 * breaking again when a new native module — one that compiles at install time
 * or ships platform-specific `.node` binaries — is pulled in transitively.
 *
 * `sharp` was the original offender: `@huggingface/transformers` depends on it,
 * there is no prebuilt win32-arm64 binary, and `node-gyp rebuild` failed on
 * GitHub Actions runners that lack the MSVC toolchain. Cairn only uses text
 * tokenization, so sharp is stubbed via the npm `overrides` field.
 *
 * To prevent a recurrence, this test enforces two invariants:
 *
 *  1. `sharp` stays stubbed (existing guard, kept in one place).
 *  2. Every package in package-lock.json with `hasInstallScript: true`
 *     (i.e. runs a postinstall/compile step) OR a `gypfile` (binding.gyp)
 *     appears on the `ALLOWED_NATIVE_DEPS` allowlist below. Each entry is
 *     annotated with how cross-platform coverage is satisfied.
 *
 * When a new native dep is added (e.g. an upgraded transitive pulls in a new
 * .node package), this test fails with a clear diff: the offending package
 * name and instructions to either:
 *   - stub it (like sharp) via package.json `overrides`, or
 *   - add it to `ALLOWED_NATIVE_DEPS` with a justification comment after
 *     verifying prebuilt win32-arm64 binaries exist.
 *
 * The allowlist is intentionally explicit and small: anything not on it must
 * be justified by a human, not silently accepted by CI.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");

type ProjectRootLockfile = {
  packages?: Record<
    string,
    {
      hasInstallScript?: boolean;
      gypfile?: boolean;
      os?: string[];
      bin?: unknown;
    }
  >;
};

function readLockfile(): ProjectRootLockfile {
  return JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf-8"));
}

/**
 * Allowlist of packages known to require native compilation / install scripts.
 * Each entry must ship prebuilt `win32-arm64` binaries OR be stubbed/exempt
 * AND is annotated with how cross-platform coverage is achieved.
 *
 * Failure modes this guard prevents (each has happened or would happen):
 *  - `sharp`              — no win32-arm64 prebuilt → stubbed via overrides
 *  - `better-sqlite3`     — compiles at install; win32-arm64 supported via
 *                           prebuilt (Chromium 141 ABI, replaced by Cairn-built
 *                           bindings at runtime for electron ABI via
 *                           electron-rebuild; for pkg runtime via pkg-native/)
 *  - `electron`           — installs platform binaries for the build host only
 *  - `electron-winstaller` — Windows packaging tool, build-host-only
 *  - `esbuild`            — ships prebuilt per-platform binaries
 *  - `fsevents`           — macOS-only ("os": ["darwin"]); does not run on Win
 *  - `node-pty`           — ships prebuilt binaries incl. win32-arm64
 *  - `onnxruntime-node`   — ships prebuilt binaries for every platform/arch
 *                           incl. darwin-x64. Pinned to 1.21.0 (napi-v3) via
 *                           @huggingface/transformers 3.7.5, because 1.24+
 *                           dropped the darwin-x64 prebuilt. This is what
 *                           lets the macOS build target both arm64 and x64.
 *  - `protobufjs`         — `postinstall` builds protoc-cli fallbacks; not a
 *                           native module, pure JS, safe on every platform
 *  - `unrs-resolver`      — ships prebuilt per-platform binaries
 *  - `iconv-corefoundation` — macOS-only ("os": ["darwin"]); does not run on Win
 *  - `@yao-pkg/pkg/node_modules/esbuild` — bundled esbuild copy for pkg, ships
 *                                          prebuilt binaries for build host
 *  - `playwright/node_modules/fsevents` — nested macOS-only fsevents
 *  - `vite/node_modules/fsevents` — nested macOS-only fsevents (vitest dep)
 */
const ALLOWED_NATIVE_DEPS = new Set([
  "better-sqlite3",
  "electron",
  "electron-winstaller",
  "esbuild",
  "fsevents",
  "node-pty",
  "onnxruntime-node",
  "protobufjs",
  "unrs-resolver",
  "iconv-corefoundation",
  "@yao-pkg/pkg/node_modules/esbuild",
  "playwright/node_modules/fsevents",
  "vite/node_modules/fsevents",
  // dsh/pi-ai transitive deps (Cordis engine):
  // - @google/genai — the Google GenAI SDK. Pure JS (build/prepare scripts
  //   only, no native binding); flagged for hasInstallScript but never compiles
  //   native code. Used only by pi-ai's Google provider, which Cairn doesn't use.
  "koffi",
  // - koffi — native FFI library; compiles/downloads prebuilt binaries via
  //   cnoke + @koromix/koffi-* (all platforms incl. win32-arm64).
  "@google/genai",
  // - dsh-subprocess-local — postinstall ensures a spawn helper; its nested
  //   node-pty ships prebuilt binaries (hasPrebuilds: true, same as root).
  "@deepseek-ai/dsh-subprocess-local",
  "@deepseek-ai/dsh-subprocess-local/node_modules/node-pty",
]);

/**
 * Packages that are macOS-only (`"os": ["darwin"]` in package.json). These are
 * exempt from win32-arm64 binary checks because they never execute on Windows.
 *
 * Why we track them separately: if any of these dependencies is updated to
 * drop the `"os"` filter (or a new dep ships without one), it would silently
 * start running on Windows arm64 and could break the build — so a new entry
 * here must be a deliberate human choice.
 */
const MACOS_ONLY_DEPS = new Set([
  "fsevents",
  "playwright/node_modules/fsevents",
  "vite/node_modules/fsevents",
  "iconv-corefoundation",
]);

describe("native deps guard", () => {
  describe("sharp stub (existing guard, kept here)", () => {
    it("package.json overrides sharp to the stub", () => {
      const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8"));
      expect(pkg.overrides?.sharp).toBe("file:electron/sharp-stub");
    });

    it("sharp-stub directory exists", () => {
      expect(existsSync(path.join(ROOT, "electron/sharp-stub/index.js"))).toBe(true);
      expect(existsSync(path.join(ROOT, "electron/sharp-stub/package.json"))).toBe(true);
    });

    it("stub exports a truthy value so transformers.js image module passes its else-if check", async () => {
      const stub = await import("./sharp-stub/index.js");
      expect(typeof stub.default).toBe("function");
      expect(stub.default).not.toBeNull();
    });
  });

  describe("allowlist of install-time-compiled packages", () => {
    const lock = readLockfile();
    const pkgs = lock.packages ?? {};

    const _nativePackages = Object.entries(pkgs)
      .filter(([name, info]) => {
        if (!name) return false; // skip root ""
        if (!info.hasInstallScript && !info.gypfile) return false;
        // nested duplicates: collapse to their leaf name (e.g.
        // "node_modules/playwright/node_modules/fsevents" ->
        // "playwright/node_modules/fsevents")
        const collapsed = name.replace(/^node_modules\//, "");
        return existsInAllowlistShape(collapsed);
      })
      .map(([name]) => name.replace(/^node_modules\//, ""));

    function existsInAllowlistShape(name: string): boolean {
      // Direct match OR allow nested duplicate like
      // "playwright/node_modules/fsevents"
      return ALLOWED_NATIVE_DEPS.has(name);
    }

    it("every compiled/native package is on the allowlist", () => {
      // Re-scan in the test so the filter above (used for sizing `nativePackages`)
      // isn't itself the source of truth — we compare against the lockfile again
      // here to surface exactly which package is unapproved.
      const offenders = Object.entries(pkgs)
        .filter(([name, info]) => name && (info.hasInstallScript || info.gypfile))
        .map(([name]) => name.replace(/^node_modules\//, ""))
        .filter((name) => !ALLOWED_NATIVE_DEPS.has(name))
        .filter((name, idx, arr) => arr.indexOf(name) === idx); // dedupe

      if (offenders.length > 0) {
        throw new Error(
          `New native dep(s) detected that are not on ALLOWED_NATIVE_DEPS.\n` +
            `These run postinstall scripts or ship a binding.gyp and may break ` +
            `cross-platform builds (especially Windows arm64):\n  - ` +
            offenders.join("\n  - ") +
            `\n\nTo fix:\n` +
            `  1. If it can be stubbed (pure JS consumer, native code never ` +
            `reachable from Cairn), add an npm override in package.json like ` +
            `the sharp stub (see "overrides.sharp" in package.json and ` +
            `electron/sharp-stub/).\n` +
            `  2. Otherwise, verify the package ships prebuilt ` +
            `win32-arm64 binaries (check node_modules/<pkg>/prebuilds/ or ` +
            `node_modules/<pkg>/bin/) and add it to ALLOWED_NATIVE_DEPS in ` +
            `electron/native-deps-guard.test.ts with a justification comment.\n`
        );
      }
    });

    it("macOS-only deps declare os:darwin filter (so they never run on Win)", () => {
      const failures: string[] = [];
      for (const name of MACOS_ONLY_DEPS) {
        const info = pkgs[`node_modules/${name}`];
        if (!info) continue; // nested duplicate, will be checked via parent
        const os = info.os;
        if (!Array.isArray(os) || !os.includes("darwin") || os.length !== 1) {
          failures.push(
            `${name}: expected "os": ["darwin"], got ${JSON.stringify(os)}`
          );
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `macOS-only deps lost their os filter; they would now run on Windows:\n  - ` +
            failures.join("\n  - ")
        );
      }
    });
  });
});
