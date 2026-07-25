import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory file backing the secrets store.
let virtualFiles: Record<string, string> = {};

vi.mock("electron", () => ({
  app: {
    isReady: () => true,
    getPath: (key: string) => (key === "userData" ? "/tmp/secure-store-test" : `/mock/${key}`),
  },
  // Reversible "encryption" so the round-trip is verifiable in tests.
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf-8"),
    decryptString: (b: Buffer) => b.toString("utf-8").replace(/^enc:/, ""),
  },
}));

vi.mock("fs", () => ({
  default: {
    existsSync: (p: string) => Object.prototype.hasOwnProperty.call(virtualFiles, p),
    readFileSync: (p: string) => {
      if (!Object.prototype.hasOwnProperty.call(virtualFiles, p)) throw new Error("ENOENT");
      return virtualFiles[p];
    },
    writeFileSync: (p: string, data: string) => {
      virtualFiles[p] = data;
    },
  },
}));

import * as store from "./secure-store";

beforeEach(() => {
  virtualFiles = {};
});

describe("secure-store pure helpers", () => {
  it("builds and detects reference tokens", () => {
    const ref = store.secretRef("mcp", "tool1", "Authorization");
    expect(ref).toBe("secret://mcp:tool1/Authorization");
    expect(store.isSecretRef(ref)).toBe(true);
    expect(store.isSecretRef("Bearer abc")).toBe(false);
    expect(store.isSecretRef("")).toBe(false);
  });

  it("detects unfilled secret placeholders", () => {
    expect(store.isPlaceholder("<API_KEY>")).toBe(true);
    expect(store.isPlaceholder("YOUR_API_KEY")).toBe(true);
    expect(store.isPlaceholder("<ACCESS_TOKEN>")).toBe(true);
    expect(store.isPlaceholder("<TOKEN>")).toBe(true);
    expect(store.isPlaceholder("  <TOKEN>  ")).toBe(true); // trimmed
    expect(store.isPlaceholder("sk-real-key")).toBe(false);
    expect(store.isPlaceholder("")).toBe(false);
  });
});

describe("secure-store persistence round-trip", () => {
  it("set/has/delete a single secret", () => {
    expect(store.hasSecret("mcp", "t1", "Authorization")).toBe(false);
    const ref = store.setSecret("mcp", "t1", "Authorization", "Bearer xyz");
    expect(ref).toBe("secret://mcp:t1/Authorization");
    expect(store.hasSecret("mcp", "t1", "Authorization")).toBe(true);

    store.deleteSecret("mcp", "t1", "Authorization");
    expect(store.hasSecret("mcp", "t1", "Authorization")).toBe(false);
  });

  it("refuses to store an unfilled placeholder value", () => {
    expect(() => store.setSecret("mcp", "t1", "Authorization", "Bearer <API_KEY>")).toThrow(/placeholder/i);
    expect(() => store.setSecret("service", "t1", "X-Api-Key", "YOUR_API_KEY")).toThrow(/placeholder/i);
    expect(store.hasSecret("mcp", "t1", "Authorization")).toBe(false);
    expect(store.hasSecret("service", "t1", "X-Api-Key")).toBe(false);
  });

  it("never persists the plaintext value on disk", () => {    store.setSecret("service", "t1", "X-Api-Key", "super-secret-123");
    const onDisk = JSON.stringify(virtualFiles);
    expect(onDisk).not.toContain("super-secret-123");
    expect(onDisk).toContain("secret://service:t1/X-Api-Key");
  });

  it("resolveSecrets swaps ref tokens for decrypted values, passes literals through", () => {
    store.setSecret("mcp", "t1", "Authorization", "Bearer xyz");
    const resolved = store.resolveSecrets({
      Authorization: store.secretRef("mcp", "t1", "Authorization"),
      "Content-Type": "application/json",
    });
    expect(resolved).toEqual({
      Authorization: "Bearer xyz",
      "Content-Type": "application/json",
    });
  });

  it("resolveSecrets drops unresolved refs rather than leaking the token", () => {
    const resolved = store.resolveSecrets({
      Authorization: "secret://mcp:missing/Authorization",
      Accept: "*/*",
    });
    expect(resolved).toEqual({ Accept: "*/*" });
    expect(resolved.Authorization).toBeUndefined();
  });

  it("resolveSecrets drops unfilled placeholder values", () => {
    const resolved = store.resolveSecrets({
      Authorization: "Bearer <API_KEY>",
      "X-Api-Key": "YOUR_API_KEY",
      Accept: "application/json",
    });
    expect(resolved).toEqual({ Accept: "application/json" });
  });

  it("resolveSecrets substitutes an embedded ref, preserving the auth scheme", () => {
    store.setSecret("service", "t1", "Authorization", "rawtoken");
    const ref = store.secretRef("service", "t1", "Authorization");
    const resolved = store.resolveSecrets({ Authorization: `Bearer ${ref}` });
    expect(resolved).toEqual({ Authorization: "Bearer rawtoken" });
  });

  it("resolveSecrets drops a header whose embedded ref can't be resolved", () => {
    const resolved = store.resolveSecrets({
      Authorization: "Bearer secret://service:missing/Authorization",
      Accept: "*/*",
    });
    expect(resolved).toEqual({ Accept: "*/*" });
    expect(resolved.Authorization).toBeUndefined();
  });

  it("deleteToolSecrets removes every secret for a tool only", () => {
    store.setSecret("mcp", "t1", "A", "a");
    store.setSecret("mcp", "t1", "B", "b");
    store.setSecret("mcp", "t2", "C", "c");

    store.deleteToolSecrets("mcp", "t1");
    expect(store.hasSecret("mcp", "t1", "A")).toBe(false);
    expect(store.hasSecret("mcp", "t1", "B")).toBe(false);
    expect(store.hasSecret("mcp", "t2", "C")).toBe(true);
  });

  it("isolates secrets per { toolType, toolId } even when ids collide", () => {
    // Same id, different tool type — must not cross-read/overwrite/delete.
    store.setSecret("mcp", "shared", "Authorization", "mcp-secret");
    store.setSecret("service", "shared", "Authorization", "svc-secret");

    expect(store.hasSecret("mcp", "shared", "Authorization")).toBe(true);
    expect(store.hasSecret("service", "shared", "Authorization")).toBe(true);

    // Resolving each ref returns its own value.
    expect(store.resolveSecrets({ Authorization: store.secretRef("mcp", "shared", "Authorization") })).toEqual({
      Authorization: "mcp-secret",
    });
    expect(store.resolveSecrets({ Authorization: store.secretRef("service", "shared", "Authorization") })).toEqual({
      Authorization: "svc-secret",
    });

    // Deleting the mcp tool's secrets leaves the service's intact.
    store.deleteToolSecrets("mcp", "shared");
    expect(store.hasSecret("mcp", "shared", "Authorization")).toBe(false);
    expect(store.hasSecret("service", "shared", "Authorization")).toBe(true);
  });
});

describe("LLM API keys", () => {
  it("stores a provider key and returns its reference token", () => {
    const ref = store.setLlmApiKey("prov1", "sk-abc123");
    expect(ref).toBe("secret://llm:prov1/apiKey");
    expect(store.llmSecretRef("prov1")).toBe(ref);
    expect(store.hasSecret("llm", "prov1", "apiKey")).toBe(true);
  });

  it("resolves a reference token back to the raw key", () => {
    const ref = store.setLlmApiKey("prov1", "sk-abc123");
    expect(store.resolveLlmApiKey(ref)).toBe("sk-abc123");
  });

  it("passes a literal (non-ref) key through unchanged", () => {
    expect(store.resolveLlmApiKey("sk-literal")).toBe("sk-literal");
  });

  it("returns empty for empty/undefined input", () => {
    expect(store.resolveLlmApiKey("")).toBe("");
    expect(store.resolveLlmApiKey(undefined)).toBe("");
    expect(store.resolveLlmApiKey(null)).toBe("");
  });

  it("returns empty when a ref can't be resolved (never leaks the token)", () => {
    expect(store.resolveLlmApiKey("secret://llm:missing/apiKey")).toBe("");
  });

  it("clears the stored key when set to empty and returns empty ref", () => {
    store.setLlmApiKey("prov1", "sk-abc123");
    expect(store.hasSecret("llm", "prov1", "apiKey")).toBe(true);
    const ref = store.setLlmApiKey("prov1", "");
    expect(ref).toBe("");
    expect(store.hasSecret("llm", "prov1", "apiKey")).toBe(false);
  });

  it("deleteLlmApiKey removes the stored key", () => {
    store.setLlmApiKey("prov1", "sk-abc123");
    store.deleteLlmApiKey("prov1");
    expect(store.hasSecret("llm", "prov1", "apiKey")).toBe(false);
  });

  it("never writes the raw key to disk (only ciphertext)", () => {
    store.setLlmApiKey("prov1", "super-secret-llm-key");
    const dump = JSON.stringify(virtualFiles);
    expect(dump).not.toContain("super-secret-llm-key");
    // Stored as base64 of the mock cipher ("enc:<value>"), never the plaintext.
    expect(dump).toContain(Buffer.from("enc:super-secret-llm-key", "utf-8").toString("base64"));
  });
});
