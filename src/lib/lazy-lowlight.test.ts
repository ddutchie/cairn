import { describe, it, expect } from "vitest";
import {
  ensureLanguage,
  isLanguageReady,
  highlightCode,
  onLanguageReady,
} from "./lazy-lowlight";

describe("lazy-lowlight", () => {
  it("is not ready before a language is loaded", () => {
    expect(isLanguageReady("javascript")).toBe(false);
  });

  it("returns null highlighting an unloaded language", () => {
    expect(highlightCode("javascript", "const x = 1;")).toBeNull();
  });

  it("returns false from ensureLanguage for unknown languages", () => {
    expect(ensureLanguage("this-is-not-a-language")).toBe(false);
    expect(ensureLanguage(undefined)).toBe(false);
  });

  it("loads a grammar on demand and highlights once ready", async () => {
    const ready = new Promise<void>((resolve) => {
      const off = onLanguageReady(() => {
        if (isLanguageReady("javascript")) {
          off();
          resolve();
        }
      });
    });
    // First call kicks off the async load and returns false (not ready yet).
    expect(ensureLanguage("javascript")).toBe(false);
    await ready;
    expect(isLanguageReady("javascript")).toBe(true);

    const tokens = highlightCode("javascript", "const x = 1;");
    expect(Array.isArray(tokens)).toBe(true);
    // At least one element node should be produced for a keyword like `const`.
    const hasElement = (tokens ?? []).some((n) => (n as { type: string }).type === "element");
    expect(hasElement).toBe(true);
  });

  it("resolves aliases to their canonical grammar (js → javascript)", async () => {
    // javascript is already loaded from the previous test; `js` alias resolves.
    expect(ensureLanguage("js")).toBe(true);
    expect(isLanguageReady("js")).toBe(true);
    const tokens = highlightCode("js", "let y = 2;");
    expect(Array.isArray(tokens)).toBe(true);
  });

  it("returns ensureLanguage=true immediately for an already-loaded language", () => {
    expect(ensureLanguage("javascript")).toBe(true);
  });
});
