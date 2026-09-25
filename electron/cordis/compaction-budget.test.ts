/**
 * Compaction fires at 80% of the message budget (window minus the output
 * reserve) on dsh 0.1.7's budget-aware engine, for small and large windows. See compaction-budget.ts.
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

/** dsh-compaction-basic 0.1.7's pressure threshold (resolveCompactSpec). */
function engineThreshold(policy: { thresholdRatio: number; headroomTokens: number }, contextWindow: number, maxTokens: number): number {
  return Math.floor(Math.min(contextWindow * policy.thresholdRatio, contextWindow - maxTokens - policy.headroomTokens));
}

describe("compactionPolicyFor", () => {
  it("fires at 80% of the message budget for the default 128K window / 32K output", () => {
    const policy = compactionPolicyFor("cairn", "m", 128_000, 32_768)!;
    const budget = 128_000 - 32_768;
    expect(engineThreshold(policy, 128_000, 32_768)).toBe(Math.floor(budget * COMPACTION_THRESHOLD_RATIO));
    expect(policy.maxTokens).toBe(policy.headroomTokens);
  });

  it("keeps auto-compaction on for windows smaller than the engine's 64K default headroom", () => {
    const policy = compactionPolicyFor("cairn", "m", 64_000, 16_000)!;
    const threshold = engineThreshold(policy, 64_000, 16_000);
    expect(threshold).toBeGreaterThan(0);
    // Default retention (16% of the budget) must stay below the threshold.
    expect(Math.floor(48_000 * 0.16)).toBeLessThan(threshold);
  });

  it("caps the summary at the route's output limit on very large windows", () => {
    const policy = compactionPolicyFor("cairn", "m", 1_000_000, 32_768)!;
    expect(policy.maxTokens).toBe(32_768);
    expect(engineThreshold(policy, 1_000_000, 32_768)).toBe(Math.floor((1_000_000 - 32_768) * COMPACTION_THRESHOLD_RATIO));
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
      config: { thresholdRatio: number; modelPolicies: Array<{ provider: string; model: string }> };
    });
    const base = { baseUrl: "http://localhost:1/v1", apiKey: "x", api: "openai-completions" as const };

    await ensureAgentAiAdapter(ctx, { ...base, model: "model-a", contextWindow: 128_000, maxTokens: 32_768 });
    expect(raw().config.thresholdRatio).toBe(COMPACTION_THRESHOLD_RATIO);
    expect(raw().config.modelPolicies).toEqual([compactionPolicyFor("cairn", "model-a", 128_000, 32_768)]);

    // A model switch replaces the route's policy instead of accumulating.
    await ensureAgentAiAdapter(ctx, { ...base, model: "model-b", contextWindow: 200_000, maxTokens: 8_000 });
    expect(raw().config.modelPolicies).toEqual([compactionPolicyFor("cairn", "model-b", 200_000, 8_000)]);
  });
});
