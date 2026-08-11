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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Point config-cache's userData resolver at a temp dir so the round-trip tests
// below never touch the developer's real ai-settings-cache.json.
let tmpDir: string;
vi.mock("../runtime/port-discovery", () => ({
  findUserDataDir: () => tmpDir,
}));

describe("config-cache AI settings round-trip", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-cfg-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists maxSteps (and other behavioural fields) for the 'ai' config", async () => {
    const { saveCachedConfig, getCachedConfig } = await import("./config-cache");
    saveCachedConfig("ai", {
      provider: "openai",
      baseUrl: "https://api.openai.com",
      model: "gpt-4o",
      apiKey: "sk-x",
      maxSteps: 1000,
      temperature: 0.5,
      contextLimit: 200000,
      aiEnabled: true,
      subagentsEnabled: true,
    });
    const ai = getCachedConfig().aiConfig;
    // Regression: maxSteps used to be silently dropped here, which reset the
    // chat tool-call limit to the default (30) on the next hydrate.
    expect(ai?.maxSteps).toBe(1000);
    expect(ai?.temperature).toBe(0.5);
    expect(ai?.contextLimit).toBe(200000);
    expect(ai?.aiEnabled).toBe(true);
    expect(ai?.subagentsEnabled).toBe(true);
    expect(ai?.model).toBe("gpt-4o");
  });

  it("persists subagentsEnabled (global subagents preference)", async () => {
    const { saveCachedConfig, getCachedConfig } = await import("./config-cache");
    saveCachedConfig("ai", { subagentsEnabled: true });
    expect(getCachedConfig().aiConfig?.subagentsEnabled).toBe(true);
    // A later connection-only save must not clobber it.
    saveCachedConfig("ai", { model: "gpt-4o" });
    expect(getCachedConfig().aiConfig?.subagentsEnabled).toBe(true);
  });

  it("a later connection-only save preserves an existing maxSteps", async () => {
    const { saveCachedConfig, getCachedConfig } = await import("./config-cache");
    saveCachedConfig("ai", { maxSteps: 500 });
    // A subsequent save that only carries connection fields (e.g. from the
    // provider picker) must not wipe the previously-stored maxSteps.
    saveCachedConfig("ai", { model: "gpt-4o-mini" });
    const ai = getCachedConfig().aiConfig;
    expect(ai?.maxSteps).toBe(500);
    expect(ai?.model).toBe("gpt-4o-mini");
  });

  it("persists maxOutputAuto / maxOutputTokens (so main-process tools honour Auto)", async () => {
    const { saveCachedConfig, getCachedConfig } = await import("./config-cache");
    saveCachedConfig("ai", { maxOutputAuto: false, maxOutputTokens: 8192 });
    expect(getCachedConfig().aiConfig?.maxOutputAuto).toBe(false);
    expect(getCachedConfig().aiConfig?.maxOutputTokens).toBe(8192);
    // Default (Auto) must be representable too: an explicit true survives.
    saveCachedConfig("ai", { maxOutputAuto: true });
    expect(getCachedConfig().aiConfig?.maxOutputAuto).toBe(true);
    // A later connection-only save must not clobber the max-output fields.
    saveCachedConfig("ai", { model: "gpt-4o" });
    const ai = getCachedConfig().aiConfig;
    expect(ai?.maxOutputAuto).toBe(true);
    expect(ai?.maxOutputTokens).toBe(8192);
  });

  it("persists installedPersonalities + the active personalityId", async () => {
    const { saveCachedConfig, getCachedConfig } = await import("./config-cache");
    const installedPersonalities = [
      {
        id: "p1",
        name: "Grill Me",
        description: "Calibrated grilling.",
        prompt: "Pressure-test plans with calibrated questions.",
        source: "community" as const,
        communityId: "grill-me",
        version: "1.0.0",
        author: "cairn",
        brandColor: "#f43f5e",
        homepage: "https://github.com/JuliusBrussee/skills",
      },
      { id: "p2", name: "Mine", prompt: "Be brief.", source: "custom" as const },
    ];
    saveCachedConfig("ai", { installedPersonalities, personalityId: "p1" });
    const ai = getCachedConfig().aiConfig;
    expect(ai?.installedPersonalities).toHaveLength(2);
    expect(ai?.installedPersonalities?.[0].communityId).toBe("grill-me");
    expect(ai?.personalityId).toBe("p1");
    // A later connection-only save must not clobber the personality fields.
    saveCachedConfig("ai", { model: "gpt-4o" });
    expect(getCachedConfig().aiConfig?.personalityId).toBe("p1");
    expect(getCachedConfig().aiConfig?.installedPersonalities).toHaveLength(2);
  });

  it("an explicit null personalityId CLEARS the cached value (the renderer's 'None' choice)", async () => {
    const { saveCachedConfig, getCachedConfig } = await import("./config-cache");
    saveCachedConfig("ai", { personalityId: "p1" });
    expect(getCachedConfig().aiConfig?.personalityId).toBe("p1");
    // The renderer sets personalityId to null to mean "None" — the cache must
    // drop the old selection, not keep it (which would resurrect the previous
    // personality on the next hydrate).
    saveCachedConfig("ai", { personalityId: null });
    expect(getCachedConfig().aiConfig?.personalityId).toBeUndefined();
    // And a later connection-only save must not resurrect it.
    saveCachedConfig("ai", { model: "gpt-4o" });
    expect(getCachedConfig().aiConfig?.personalityId).toBeUndefined();
  });
});

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
