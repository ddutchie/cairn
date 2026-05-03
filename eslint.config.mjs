import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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

      // Honour the _name convention for intentionally-unused vars/params.
      "@typescript-eslint/no-unused-vars": ["warn", {
        varsIgnorePattern: "^_",
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
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
    // Plain Node.js CJS build/helper scripts
    "scripts/**",
    // Vitest SQLite shim — CJS, require() is intentional
    "vitest-sqlite-shim.cjs",
  ]),
]);

export default eslintConfig;
