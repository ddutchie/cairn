/**
 * Unit tests for electron/db/usage-queries.ts
 *
 * Uses an in-memory SQLite database (system Node better-sqlite3 binding —
 * vitest runs in plain Node, no Electron ABI required).
 */

import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "./schema";
import { insertLlmUsage, queryUsageOverview, queryRecentUsage, applyRecoveredTurnCost, type LlmUsageRecord } from "./usage-queries";

// The per-day series buckets via SQLite's `localtime` modifier, which honours
// the process TZ. Pin it to UTC so the "2026-08-05 / 2026-08-06" date
// assertions are deterministic on any host (an east-of-UTC timezone would
// shift noon-UTC rows into the following day).
process.env.TZ = "UTC";

describe("usage-queries", () => {
  let db: Database.Database;

  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 7, 6, 12, 0, 0); // Aug 6 2026 noon UTC

  const rec = (over: Partial<LlmUsageRecord>): LlmUsageRecord => ({
    id: `${over.source}-${Math.random().toString(36).slice(2, 8)}`,
    source: "chat",
    model: "deepseek-v4-flash",
    promptTokens: 100,
    completionTokens: 50,
    reasoningTokens: 0,
    costUsd: 0.01,
    createdAt: NOW,
    ...over,
  });

  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    applySchema(db);
  });

  it("inserts and aggregates totals/series/source/model", () => {
    insertLlmUsage(db, rec({ source: "chat", model: "deepseek-v4-flash", promptTokens: 100, completionTokens: 50, costUsd: 0.01, createdAt: NOW - DAY }));
    insertLlmUsage(db, rec({ source: "pi-agent", model: "claude-sonnet-4-5", promptTokens: 200, completionTokens: 60, reasoningTokens: 20, costUsd: 0.5, createdAt: NOW }));
    insertLlmUsage(db, rec({ source: "automation", model: "deepseek-v4-flash", promptTokens: 300, completionTokens: 90, costUsd: 0.02, createdAt: NOW }));

    const overview = queryUsageOverview(db, {});

    expect(overview.totals).toMatchObject({
      promptTokens: 600,
      completionTokens: 200,
      reasoningTokens: 20,
      costUsd: 0.53,
      requests: 3,
    });
    // Two distinct days → two buckets (Aug 5, Aug 6).
    expect(overview.series).toHaveLength(2);
    expect(overview.series[0].day).toBe("2026-08-05");
    expect(overview.series[1].day).toBe("2026-08-06");
    // Source breakdown sorted by tokens desc: automation (390), pi-agent (260), chat (150).
    expect(overview.bySource.map((s) => s.source)).toEqual(["automation", "pi-agent", "chat"]);
    // Model breakdown: deepseek-v4-flash 540 > claude-sonnet-4-5 260.
    expect(overview.byModel[0].model).toBe("deepseek-v4-flash");
    expect(overview.byModel[0].promptTokens).toBe(400);
    // Previous window (equal width before the range) is null when no from/to.
    expect(overview.previous).toBeNull();
  });

  it("computes the previous window for deltas", () => {
    insertLlmUsage(db, rec({ source: "chat", promptTokens: 50, costUsd: 0.005, createdAt: NOW - 2 * DAY }));
    insertLlmUsage(db, rec({ source: "chat", promptTokens: 200, costUsd: 0.02, createdAt: NOW - DAY }));
    insertLlmUsage(db, rec({ source: "chat", promptTokens: 400, costUsd: 0.04, createdAt: NOW }));

    // Range = the last two days; previous = the two days before them.
    const overview = queryUsageOverview(db, { from: NOW - 2 * DAY + 1, to: NOW });
    expect(overview.totals.promptTokens).toBe(600);
    expect(overview.previous).not.toBeNull();
    expect(overview.previous!.promptTokens).toBe(50);
  });

  it("scopes by source filter", () => {
    insertLlmUsage(db, rec({ source: "chat", promptTokens: 100 }));
    insertLlmUsage(db, rec({ source: "pi-agent", promptTokens: 200 }));
    const overview = queryUsageOverview(db, { source: "chat" });
    expect(overview.totals.requests).toBe(1);
    expect(overview.totals.promptTokens).toBe(100);
  });

  it("includes workspace rows plus global (NULL workspace) rows when scoping by workspace", () => {
    insertLlmUsage(db, rec({ source: "chat", workspaceId: "ws-1", promptTokens: 100 }));
    insertLlmUsage(db, rec({ source: "chat", workspaceId: "ws-2", promptTokens: 200 }));
    insertLlmUsage(db, rec({ source: "commit-message", workspaceId: undefined, promptTokens: 300 }));

    const ws1 = queryUsageOverview(db, { workspaceId: "ws-1" });
    // ws-1 row + the global row.
    expect(ws1.totals.promptTokens).toBe(400);
    expect(ws1.totals.requests).toBe(2);

    const all = queryUsageOverview(db, {});
    expect(all.totals.promptTokens).toBe(600);
  });

  it("returns recent rows newest-first", () => {
    insertLlmUsage(db, rec({ source: "chat", model: "old", createdAt: NOW - 2 * DAY }));
    insertLlmUsage(db, rec({ source: "chat", model: "mid", createdAt: NOW - DAY }));
    insertLlmUsage(db, rec({ source: "pi-agent", model: "new", costUsd: 0.5, costEstimated: true, createdAt: NOW }));

    const recent = queryRecentUsage(db, {}, 10);
    expect(recent.map((r) => r.model)).toEqual(["new", "mid", "old"]);
    expect(recent[0].source).toBe("pi-agent");
    expect(recent[0].reasoningTokens).toBe(0);
    expect(recent[0].costUsd).toBe(0.5);
    expect(recent[0].costEstimated).toBe(true);
    expect(recent[1].costEstimated).toBe(false);
  });

  it("honours the recent limit", () => {
    for (let i = 0; i < 5; i++) {
      insertLlmUsage(db, rec({ source: "chat", model: `m${i}`, createdAt: NOW - i * 1000 }));
    }
    const recent = queryRecentUsage(db, {}, 2);
    expect(recent).toHaveLength(2);
    expect(recent[0].model).toBe("m0");
  });

  it("persists and aggregates prompt-cache tokens", () => {
    insertLlmUsage(db, rec({ source: "chat", promptTokens: 1000, cacheReadTokens: 700, cacheCreationTokens: 0, createdAt: NOW - DAY }));
    insertLlmUsage(db, rec({ source: "pi-agent", promptTokens: 500, cacheReadTokens: 100, cacheCreationTokens: 50, createdAt: NOW }));

    const overview = queryUsageOverview(db, {});
    expect(overview.totals.cacheReadTokens).toBe(800);
    expect(overview.totals.promptTokens).toBe(1500);
    // Cached input rides along in the day series too.
    expect(overview.series).toHaveLength(2);

    const recent = queryRecentUsage(db, {}, 10);
    expect(recent[0].source).toBe("pi-agent");
    expect(recent[0].cacheReadTokens).toBe(100);
    expect(recent[0].cacheCreationTokens).toBe(50);
    expect(recent[1].cacheReadTokens).toBe(700);
    expect(recent[1].cacheCreationTokens).toBe(0);
  });

  it("excludes rows with estimated or missing cost when the filter is set", () => {
    insertLlmUsage(db, rec({ source: "chat", promptTokens: 100, costUsd: 0.01, costEstimated: false, createdAt: NOW - 1000 }));
    insertLlmUsage(db, rec({ source: "chat", promptTokens: 200, costUsd: 0.02, costEstimated: true, createdAt: NOW }));
    insertLlmUsage(db, rec({ source: "pi-agent", promptTokens: 300, costUsd: 0.03, costEstimated: false, createdAt: NOW }));
    // Not an estimate, but the provider reported no cost AND no model price is
    // known — no real cost either, so it must be dropped alongside estimates.
    insertLlmUsage(db, rec({ source: "chat", promptTokens: 400, costUsd: undefined, costEstimated: false, createdAt: NOW }));

    const all = queryUsageOverview(db, {});
    expect(all.totals.requests).toBe(4);
    expect(all.totals.promptTokens).toBe(1000);
    expect(all.totals.costUsd).toBeCloseTo(0.06, 6);

    const real = queryUsageOverview(db, { excludeEstimated: true });
    expect(real.totals.requests).toBe(2);
    expect(real.totals.promptTokens).toBe(400);
    expect(real.totals.costUsd).toBeCloseTo(0.04, 6);

    const recent = queryRecentUsage(db, { excludeEstimated: true }, 10);
    expect(recent).toHaveLength(2);
    expect(recent.every((r) => r.costEstimated === false)).toBe(true);
    expect(recent.every((r) => r.costUsd != null)).toBe(true);
  });

  it("writes a recovered turn cost back onto estimated rows proportionally", () => {
    insertLlmUsage(db, rec({ source: "chat", sessionId: "t1", completionTokens: 100, costUsd: 0.01, costEstimated: true, createdAt: NOW }));
    insertLlmUsage(db, rec({ source: "chat", sessionId: "t1", completionTokens: 300, costUsd: 0.03, costEstimated: true, createdAt: NOW + 1 }));
    // A different thread must be untouched.
    insertLlmUsage(db, rec({ source: "chat", sessionId: "other", completionTokens: 50, costUsd: 0.02, costEstimated: true, createdAt: NOW }));

    applyRecoveredTurnCost(db, "t1", NOW, 1.0);

    const rows = queryRecentUsage(db, {}, 10).filter((r) => r.sessionId === "t1");
    expect(rows).toHaveLength(2);
    // Estimates replaced by the recovered cost (100/400 and 300/400 of $1).
    expect(rows.find((r) => r.completionTokens === 100)!.costUsd).toBeCloseTo(0.25, 6);
    expect(rows.find((r) => r.completionTokens === 300)!.costUsd).toBeCloseTo(0.75, 6);
    expect(rows.every((r) => r.costEstimated === false)).toBe(true);

    // The other thread's row still has its estimate.
    const other = queryRecentUsage(db, {}, 10).find((r) => r.sessionId === "other")!;
    expect(other.costUsd).toBe(0.02);
    expect(other.costEstimated).toBe(true);
  });
});
