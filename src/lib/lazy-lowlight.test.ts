import { describe, it, expect, vi } from "vitest";

/**
 * Each test imports a FRESH module instance (vi.resetModules + dynamic
 * import) because the registry is module-global: tests must not depend on
 * execution order (fails under --sequence.shuffle otherwise).
 */
async function freshModule() {
  vi.resetModules();
  return await import("./lazy-lowlight");
}

describe("lazy-lowlight", () => {
  it("is not ready before a language is loaded", async () => {
    const { isLanguageReady } = await freshModule();
    expect(isLanguageReady("javascript")).toBe(false);
  });

  it("returns null highlighting an unloaded language", async () => {
    const { highlightCode } = await freshModule();
    expect(highlightCode("javascript", "const x = 1;")).toBeNull();
  });

  it("returns false from ensureLanguage for unknown languages", async () => {
    const { ensureLanguage } = await freshModule();
    expect(ensureLanguage("this-is-not-a-language")).toBe(false);
    expect(ensureLanguage(undefined)).toBe(false);
  });

  it("loads a grammar on demand and highlights once ready", async () => {
    const { ensureLanguage, isLanguageReady, highlightCode, onLanguageReady } = await freshModule();
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
    const { ensureLanguage, isLanguageReady, highlightCode, onLanguageReady } = await freshModule();
    expect(ensureLanguage("javascript")).toBe(false);
    await new Promise<void>((resolve) => {
      const off = onLanguageReady(() => {
        if (isLanguageReady("javascript")) {
          off();
          resolve();
        }
      });
    });
    // `js` alias resolves once the canonical grammar is loaded.
    expect(ensureLanguage("js")).toBe(true);
    expect(isLanguageReady("js")).toBe(true);
    const tokens = highlightCode("js", "let y = 2;");
    expect(Array.isArray(tokens)).toBe(true);
  });

  it("returns ensureLanguage=true immediately for an already-loaded language", async () => {
    const { ensureLanguage, isLanguageReady, onLanguageReady } = await freshModule();
    expect(ensureLanguage("javascript")).toBe(false);
    await new Promise<void>((resolve) => {
      const off = onLanguageReady(() => {
        if (isLanguageReady("javascript")) {
          off();
          resolve();
        }
      });
    });
    expect(ensureLanguage("javascript")).toBe(true);
  });
});
