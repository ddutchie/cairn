import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["electron/**/*.test.ts", "src/**/*.test.ts"],
    globals: true,
    // Use the system Node (pkg-native) better-sqlite3 binding.
    // After `npm run rebuild`, node_modules/ has the Electron ABI; pkg-native/
    // always has the system Node ABI that vitest (plain Node) requires.
    env: {
      BETTER_SQLITE3_BINDING: path.resolve(__dirname, "pkg-native/better_sqlite3.node"),
    },
  },
  resolve: {
    alias: {
      // Redirect better-sqlite3 so it loads via nativeBinding from pkg-native/
      "better-sqlite3": path.resolve(__dirname, "vitest-sqlite-shim.cjs"),
    },
  },
});
