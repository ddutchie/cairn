import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let reactVersion = "19.2.7";
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  const reactDep = pkg.dependencies?.react || pkg.devDependencies?.react;
  if (reactDep) {
    reactVersion = reactDep.replace(/^[^0-9]+/, "");
  }
} catch {
  // fallback
}

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // react-hooks/set-state-in-effect fires on well-established patterns like
      // seeding a controlled input when a modal opens, detecting the platform on
      // mount, or resetting derived state when a prop changes. These are all
      // correct uses of useEffect — the rule is too strict for this codebase.
      "react-hooks/set-state-in-effect": "warn",

      // Cairn is a static-export Electron desktop app — next/image's lazy-loading
      // and CDN optimisations don't apply. Plain <img> tags are correct here.
      "@next/next/no-img-element": "off",

      // react-hooks/purity flags Date.now() inside useMemo, which is the
    // recommended pattern for snapshotting time at render in a stable way.
    // Downgrade to warn so build-blocking errors don't fire on this idiom.
    "react-hooks/purity": "warn",

      // useTilt exposes a stable ref object (not ref.current) during render
      // via `ref={tilt.ref}` — the rule's `ref.current` guard false-positives
      // on this shape. Downgrade to warn; tilt still opts into reduced-motion
      // and rAF correctly.
      "react-hooks/refs": "warn",

    // Honour the _name convention for intentionally-unused vars/params.
      "@typescript-eslint/no-unused-vars": ["warn", {
        varsIgnorePattern: "^_",
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
    settings: {
      react: {
        version: reactVersion,
      },
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Compiled Electron + MCP bundles — not source
    "dist-electron/**",
    "dist-mcp/**",
    // Mobile (Expo/React Native) has its own RN-aware ESLint config
    // (mobile/eslint.config.js). The Next.js/web rules here flag valid RN
    // patterns, so it is linted separately.
    "mobile/**",
    // Remotion video compositions — separate build pipeline, not part of app
    "remotion/**",
    // Scratch experiments (Needle finetune spike, venvs, checkpoints) —
    // gitignored + untracked; not part of the app and not seen by CI.
    "scratch/**",
    // Plain Node.js CJS build/helper scripts
    "scripts/**",
    // Vitest SQLite shim — CJS, require() is intentional
    "vitest-sqlite-shim.cjs",
  ]),
]);

export default eslintConfig;
