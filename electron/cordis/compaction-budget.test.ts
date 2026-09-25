/**
 * Compaction pressure is scaled to the message budget (window minus the
 * output reserve), so auto-compaction fires before the provider refuses the
 * prompt. See compaction-budget.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { symbols } from "@deepseek-ai/cordis";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { setPluginsRoot } from "./plugin-loader";
import { setSessionRoot, getContext } from "./run-cordis-loop";
import { ensureAgentAiAdapter } from "./session-runtime";
import { compactionPolicyFor, COMPACTION_THRESHOLD_RATIO } from "./compaction-budget";

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-compaction-"));
  setSessionRoot(path.join(tmp, "sessions"));
  setPluginsRoot(path.join(tmp, "plugins"));
});

describe("compactionPolicyFor", () => {
  it("fires below the provider limit for the default 128K window / 32K output", () => {
    const policy = compactionPolicyFor("cairn", "m", 128_000, 32_768)!;
    expect(policy.thresholdRatio).toBe(0.595);
    expect(128_000 * policy.thresholdRatio).toBeLessThan(128_000 - 32_768);
    expect(policy.retainRatio).toBeUndefined();
  });

  it("stays close to the base ratio when the output reserve is small", () => {
    const policy = compactionPolicyFor("cairn", "m", 1_000_000, 32_768)!;
    expect(policy.thresholdRatio).toBeGreaterThan(0.77);
    expect(policy.thresholdRatio).toBeLessThan(COMPACTION_THRESHOLD_RATIO);
  });

  it("keeps retention below the threshold for tiny budgets", () => {
    const policy = compactionPolicyFor("cairn", "m", 40_000, 32_768)!;
    expect(policy.retainRatio).toBeLessThan(policy.thresholdRatio);
  });

  it("skips routes whose output reserve consumes the whole window", () => {
    expect(compactionPolicyFor("cairn", "m", 32_000, 32_768)).toBeUndefined();
    expect(compactionPolicyFor("cairn", "m", 0, 1)).toBeUndefined();
  });
});

describe("applyCompactionBudget (live engine)", () => {
  it("installs and replaces the Cairn route policy on the mounted compaction engine", async () => {
    const ctx = await getContext();
    const raw = () => ((ctx as unknown as { compaction: Record<symbol, unknown> }).compaction[symbols.original] as {
      config: { thresholdRatio: number; modelPolicies: Array<{ provider: string; model: string; thresholdRatio: number }> };
    });
    const base = { baseUrl: "http://localhost:1/v1", apiKey: "x", api: "openai-completions" as const };

    await ensureAgentAiAdapter(ctx, { ...base, model: "model-a", contextWindow: 128_000, maxTokens: 32_768 });
    expect(raw().config.thresholdRatio).toBe(COMPACTION_THRESHOLD_RATIO);
    expect(raw().config.modelPolicies).toEqual([{ provider: "cairn", model: "model-a", thresholdRatio: 0.595 }]);

    // A model switch replaces the route's policy instead of accumulating.
    await ensureAgentAiAdapter(ctx, { ...base, model: "model-b", contextWindow: 200_000, maxTokens: 8_000 });
    expect(raw().config.modelPolicies).toEqual([{ provider: "cairn", model: "model-b", thresholdRatio: 0.768 }]);
  });
});
