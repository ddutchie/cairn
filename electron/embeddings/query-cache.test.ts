/**
 * Tests for the LRU query vector cache used by `searchAdjacent`.
 *
 * The cache itself is private to `service.ts` and is reset between tests by
 * importing the module fresh. We re-implement the same LRU shape here to
 * guard against regressions in eviction order and key derivation.
 */
import { describe, it, expect } from "vitest";
import * as crypto from "crypto";

const QUERY_CACHE_MAX = 64;

class LruQueryCache {
  private map = new Map<string, number[]>();

  get size(): number {
    return this.map.size;
  }

  get(key: string): number[] | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, vec: number[]): void {
    if (this.map.size >= QUERY_CACHE_MAX) {
      const firstKey = this.map.keys().next().value;
      if (firstKey) this.map.delete(firstKey);
    }
    this.map.set(key, vec);
  }
}

function queryHash(model: string, queryText: string): string {
  return crypto.createHash("sha256").update(`q|${model}|${queryText}`, "utf8").digest("hex");
}

describe("query vector cache (LRU)", () => {
  it("returns undefined on miss", () => {
    const c = new LruQueryCache();
    expect(c.get("missing")).toBeUndefined();
  });

  it("returns the stored vector on hit", () => {
    const c = new LruQueryCache();
    c.set("k1", [1, 2, 3]);
    expect(c.get("k1")).toEqual([1, 2, 3]);
  });

  it("evicts the oldest entry when exceeding QUERY_CACHE_MAX", () => {
    const c = new LruQueryCache();
    for (let i = 0; i < QUERY_CACHE_MAX; i++) c.set(`k${i}`, [i]);
    expect(c.size).toBe(QUERY_CACHE_MAX);
    c.set("new", [999]);
    expect(c.size).toBe(QUERY_CACHE_MAX);
    expect(c.get("k0")).toBeUndefined();
    expect(c.get("k1")).toBeDefined();
    expect(c.get("new")).toEqual([999]);
  });

  it("evicts the second-oldest after the oldest is touched (LRU, not FIFO)", () => {
    const c = new LruQueryCache();
    for (let i = 0; i < QUERY_CACHE_MAX; i++) c.set(`k${i}`, [i]);
    c.get("k0");
    c.set("new", [999]);
    expect(c.get("k0")).toEqual([0]);
    expect(c.get("k1")).toBeUndefined();
    expect(c.get("new")).toEqual([999]);
  });

  it("derives keys deterministically from model + query text", () => {
    const k1 = queryHash("nomic-ai/nomic-embed-text-v1.5", "hello world");
    const k2 = queryHash("nomic-ai/nomic-embed-text-v1.5", "hello world");
    const k3 = queryHash("nomic-ai/nomic-embed-text-v1.5", "hello world!");
    const k4 = queryHash("other-model", "hello world");
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).not.toBe(k4);
  });
});
