import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import { config as loadDotenv } from "dotenv";

// Load .env.test so test-only variables (TEST_LLM_BASE_URL etc.) are available.
// The file is gitignored; missing is fine — variables simply won't be set.
loadDotenv({ path: path.resolve(__dirname, ".env.test"), override: false });

const sharedAlias = {
  // Redirect better-sqlite3 so it loads via nativeBinding from vitest-native/
  "better-sqlite3": path.resolve(__dirname, "vitest-sqlite-shim.cjs"),
  "@": path.resolve(__dirname, "./src"),
};

// Mobile (Expo) lives in its own root with its own `@` → mobile/src alias, so
// its pure-logic tests get a dedicated project. Kept node-only + narrow: mobile
// test files must import only framework-free logic (no react-native/expo at
// module load), matching what plain-Node vitest can evaluate.
const mobileAlias = {
  // Order matters: the subpath entry must precede the bare package entry so
  // "@cairn/shared/foo" doesn't get swallowed by the "@cairn/shared" alias.
  "@cairn/shared/": path.resolve(__dirname, "./shared") + "/",
  "@cairn/shared": path.resolve(__dirname, "./shared/sync/index.ts"),
  "@": path.resolve(__dirname, "./mobile/src"),
};


export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    globals: true,
    // Two projects:
    //  - "node": the default fast suite (store/lib/electron logic, native sqlite).
    //    Component tests (*.component.test.tsx) are excluded here.
    //  - "component": React component tests rendered in jsdom via Testing Library.
    projects: [
      {
        plugins: [react()],
        resolve: { alias: sharedAlias },
        test: {
          name: "node",
          environment: "node",
          globals: true,
          include: ["electron/**/*.test.ts", "shared/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
          exclude: ["src/**/*.component.test.tsx"],
          env: {
            BETTER_SQLITE3_BINDING: path.resolve(__dirname, "vitest-native/better_sqlite3.node"),
          },
        },
      },
      {
        plugins: [react()],
        resolve: { alias: sharedAlias },
        test: {
          name: "component",
          environment: "jsdom",
          globals: true,
          include: ["src/**/*.component.test.tsx"],
          setupFiles: ["./vitest.setup.components.ts"],
        },
      },
      {
        resolve: { alias: mobileAlias },
        // Disable tsconfig auto-discovery for the oxc transform so it does NOT
        // walk up and load mobile/tsconfig.json — that file
        // `extends "expo/tsconfig.base"`, which is only installed under
        // mobile/node_modules and is unresolvable from the repo-root vitest run
        // (CI installs root deps only, so the transform fails with "Tsconfig
        // not found"). These are plain-TS pure-logic tests; path aliases
        // resolve via resolve.alias above, so no tsconfig paths are needed.
        oxc: { tsconfig: false },
        test: {
          name: "mobile",
          environment: "node",
          globals: true,
          include: ["mobile/**/*.test.ts"],
        },
      },
    ],
  },
});
