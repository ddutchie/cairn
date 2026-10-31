/** The retired built-in "rork" provider reads as the bring-your-own-key default. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ meta: new Map<string, string>() }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("../db", () => ({
  getMeta: (k: string) => h.meta.get(k) ?? null,
  setMeta: (k: string, v: string) => { h.meta.set(k, v); },
  getDb: () => { throw new Error("no db"); },
}));
vi.mock("@modules/apple-llm", () => ({}));

const { getProviderPref } = await import("./ai-config");

beforeEach(() => h.meta.clear());

describe("getProviderPref", () => {
  it("defaults to OpenAI-compatible", () => {
    expect(getProviderPref()).toBe("openai");
  });
  it("keeps an explicit Apple choice", () => {
    h.meta.set("ai.provider", "apple");
    expect(getProviderPref()).toBe("apple");
  });
  it("moves users who had the retired Rork provider to OpenAI-compatible", () => {
    h.meta.set("ai.provider", "rork");
    expect(getProviderPref()).toBe("openai");
  });
});
