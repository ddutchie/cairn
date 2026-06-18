import { defineConfig } from "vitest/config";
import path from "path";
import { config as loadDotenv } from "dotenv";

// Load .env.test so test-only variables (TEST_LLM_BASE_URL etc.) are available.
// The file is gitignored; missing is fine — variables simply won't be set.
loadDotenv({ path: path.resolve(__dirname, ".env.test"), override: false });

export default defineConfig({
  test: {
    environment: "node",
    include: ["electron/**/*.test.ts", "src/**/*.test.ts"],
    globals: true,
    // Tell the vitest-sqlite-shim.cjs where to find the system-Node-ABI binary.
    // vitest-native/ holds the build for the currently-running Node (saved by
    // `npm run rebuild`); pkg-native/ is Node 22 ABI for the pkg-bundled MCP
    // binary and would mismatch on Node != 22.
    env: {
      BETTER_SQLITE3_BINDING: path.resolve(__dirname, "vitest-native/better_sqlite3.node"),
    },
  },
  resolve: {
    alias: {
      // Redirect better-sqlite3 so it loads via nativeBinding from vitest-native/
      "better-sqlite3": path.resolve(__dirname, "vitest-sqlite-shim.cjs"),
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
