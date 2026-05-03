import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
