/**
 * Upstream features mounted on the shared context (dsh 0.1.7):
 *   - dsh-tool-session-query: the five read-only past-session tools, over
 *     the session-query-sqlite index, never gated by approval;
 *   - dsh-compaction-image-offload: mounted, so an over-image-budget request
 *     drops the oldest images instead of failing the turn.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { setPluginsRoot } from "./plugin-loader";
import { setSessionRoot, getContext } from "./run-cordis-loop";
import { needsApproval, riskForTool } from "../../shared/agent/tool-risk";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
}));

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-session-query-"));
  setSessionRoot(path.join(tmp, "sessions"));
  setPluginsRoot(path.join(tmp, "plugins"));
});

const SESSION_TOOLS = ["session_search", "session_event_search", "session_trace", "session_event_trace", "session_event_read"];

describe("shared-context upstream features", () => {
  it("registers the session-query tools as read-only", async () => {
    const ctx = await getContext();
    const tools = (ctx as unknown as { tools: { get(name: string): unknown } }).tools;
    for (const name of SESSION_TOOLS) {
      expect(tools.get(name), name).toBeDefined();
      expect(needsApproval(name)).toBe(false);
      expect(riskForTool(name)).toBe("READ");
    }
  });

  it("mounts the image-offload and session-query loader entries", async () => {
    const ctx = await getContext();
    const loader = (ctx as unknown as { loader: { entries(): Iterable<{ options: { id: string }; fiber?: unknown }> } }).loader;
    const ids = new Map([...loader.entries()].map((e) => [e.options.id, e]));
    for (const id of ["image-offload", "tool-session-query"]) {
      expect(ids.get(id)?.fiber, id).toBeDefined();
    }
  });
});
