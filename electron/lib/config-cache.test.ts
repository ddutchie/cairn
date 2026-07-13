/**
 * config-cache Electron-independence guard
 *
 * `lib/config-cache.ts` is imported by the semantic-search MCP tools
 * (`mcp/tools/graph.ts` → dynamic `import("../../lib/config-cache")`). The
 * standalone MCP server runs on a pkg/Node runtime with NO working `electron`
 * module — requiring it throws "Electron failed to install correctly". This
 * previously broke `search_notes_semantic` with exactly that error.
 *
 * The fix: config-cache must NOT statically `import { app } from "electron"`.
 * It resolves userData defensively (lazy require inside try/catch, else the
 * filesystem scan shared with mcp/db.ts). These tests lock that in:
 *   1. Importing the module must not throw (no eager electron eval).
 *   2. getEmbeddingsSettingsCached() must run without throwing when electron
 *      is unavailable — returning a plain object (possibly empty).
 */
import { describe, it, expect } from "vitest";

describe("config-cache without Electron", () => {
  it("imports without throwing the electron install error", async () => {
    // A static `import { app } from "electron"` would blow up here in the
    // vitest Node environment (no Electron ABI), just like in the MCP runtime.
    await expect(import("./config-cache")).resolves.toBeDefined();
  });

  it("getEmbeddingsSettingsCached() does not throw when electron is unavailable", async () => {
    const { getEmbeddingsSettingsCached } = await import("./config-cache");
    expect(() => getEmbeddingsSettingsCached()).not.toThrow();
    // Shape guard: always an object (real settings if a cache file exists on
    // this machine, otherwise {}). Never undefined/null.
    const settings = getEmbeddingsSettingsCached();
    expect(settings).toBeTypeOf("object");
    expect(settings).not.toBeNull();
  });
});
