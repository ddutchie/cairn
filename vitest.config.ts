import { defineConfig } from "vitest/config";
import type { UserConfig } from "vite";
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
        // The mobile app's tsconfig `extends "expo/tsconfig.base"`, which only
        // resolves when `mobile/node_modules` is installed. CI installs only the
        // root deps, so oxc's automatic tsconfig walk-up for mobile test files
        // hits mobile/tsconfig.json and fails with TSCONFIG_ERROR (Tsconfig not
        // found). Disable oxc's tsconfig lookup for this project and feed it a
        // self-contained config instead, so the transform never touches the
        // expo-extended mobile/tsconfig.json.
        plugins: [
          {
            name: "mobile-standalone-tsconfig",
            // Vite's public OxcOptions type omits `tsconfig`, but the underlying
            // oxc transform reads it at runtime (it's spread straight into the
            // native transformSync call). An inline raw tsconfig here makes the
            // transform skip its filesystem walk-up entirely. Cast because the
            // field isn't in the exposed type surface.
            config() {
              return {
                oxc: {
                  tsconfig: {
                    compilerOptions: {
                      target: "es2022",
                      jsx: "react-jsx",
                      verbatimModuleSyntax: false,
                    },
                  },
                } as unknown as UserConfig["oxc"],
              };
            },
          },
        ],
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
