/**
 * Unit test for the chat fs-chain artifact remap: plugin tools that resolve
 * hardcoded `viz/…` paths (dsh-visualize) must land in `.chat/viz/…`, and the
 * patch must be idempotent + passthrough for everything else.
 */
import { describe, it, expect } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { remapChatArtifactDirs } from "./cordis-coding-tools";

function fakeCtx(fsSvc: Record<string, unknown> | undefined): Context {
  return {
    get: (n: string) => (n === "fs" ? fsSvc : undefined),
  } as unknown as Context;
}

describe("remapChatArtifactDirs", () => {
  it("rewrites viz/ resolves to .chat/viz/, passes others through, idempotent", async () => {
    const seen: string[] = [];
    const fsSvc = {
      resolve: async (p: string) => { seen.push(p); return { targetKey: p }; },
    };
    const ctx = fakeCtx(fsSvc);
    remapChatArtifactDirs(ctx);
    await fsSvc.resolve!("viz/a-b-123.html" as never);
    await fsSvc.resolve!("notes/todos.md" as never);
    expect(seen).toEqual([".chat/viz/a-b-123.html", "notes/todos.md"]);
    // Bare "viz" also remaps; second patch call is a no-op (flag set).
    remapChatArtifactDirs(ctx);
    await fsSvc.resolve!("viz" as never);
    expect(seen).toEqual([".chat/viz/a-b-123.html", "notes/todos.md", ".chat/viz"]);
  });

  it("no-ops without an fs service", () => {
    expect(() => remapChatArtifactDirs(fakeCtx(undefined))).not.toThrow();
  });
});
