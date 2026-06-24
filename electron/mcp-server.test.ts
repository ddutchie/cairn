/**
 * MCP server smoke test
 *
 * Spawns the bundled JS (dist-mcp/mcp-server.bundle.js) as a subprocess and
 * verifies it does NOT crash with the Zod "undefined is not a constructor"
 * error that occurs when `init_zod()` runs after the MCP SDK's inline
 * types.js code.
 *
 * The Zod crash happens synchronously at module load time, so we just need
 * to check stderr for the crash pattern within a short window. If the
 * process survives module load (outputs anything to stderr, exits cleanly,
 * hits a Node version mismatch, or waits for stdin), the Zod init passed.
 */
import { describe, it, expect, onTestFailed } from "vitest";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const BUNDLE_PATH = path.resolve(__dirname, "..", "dist-mcp", "mcp-server.bundle.js");
const STARTUP_WAIT_MS = 5_000;

describe("MCP server bundle", () => {
  it.skipIf(!fs.existsSync(BUNDLE_PATH))(
    "does not crash at module load (Zod init ordering guard)",
    { timeout: 15_000 },
    async () => {
      const stderrChunks: string[] = [];

      const proc = spawn("node", [BUNDLE_PATH], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      proc.stderr!.setEncoding("utf8");
      proc.stderr!.on("data", (chunk) => stderrChunks.push(chunk));

      onTestFailed(() => {
        if (!proc.killed) proc.kill();
      });

      // Wait for the process to either crash (synchronous module load error)
      // or reach its first await point (starts listening on stdin).
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          resolve(); // survived startup window
        }, STARTUP_WAIT_MS);

        proc.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });

        proc.on("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      if (!proc.killed) proc.kill();

      const stderr = stderrChunks.join("");

      // The Zod crash always manifests as this specific TypeError on stderr.
      // Any other stderr output (DB path, no-DB message, Node version
      // mismatch, etc.) means Zod init succeeded.
      expect(stderr).not.toContain("undefined is not a constructor");
      expect(stderr).not.toContain("TypeError: ");
    },
  );
});
