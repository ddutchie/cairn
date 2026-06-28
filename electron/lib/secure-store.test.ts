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
    const ref = store.secretRef("tool1", "Authorization");
    expect(ref).toBe("secret://tool1/Authorization");
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
    expect(store.hasSecret("t1", "Authorization")).toBe(false);
    const ref = store.setSecret("t1", "Authorization", "Bearer xyz");
    expect(ref).toBe("secret://t1/Authorization");
    expect(store.hasSecret("t1", "Authorization")).toBe(true);

    store.deleteSecret("t1", "Authorization");
    expect(store.hasSecret("t1", "Authorization")).toBe(false);
  });

  it("never persists the plaintext value on disk", () => {
    store.setSecret("t1", "X-Api-Key", "super-secret-123");
    const onDisk = JSON.stringify(virtualFiles);
    expect(onDisk).not.toContain("super-secret-123");
    expect(onDisk).toContain("secret://t1/X-Api-Key");
  });

  it("resolveSecrets swaps ref tokens for decrypted values, passes literals through", () => {
    store.setSecret("t1", "Authorization", "Bearer xyz");
    const resolved = store.resolveSecrets({
      Authorization: store.secretRef("t1", "Authorization"),
      "Content-Type": "application/json",
    });
    expect(resolved).toEqual({
      Authorization: "Bearer xyz",
      "Content-Type": "application/json",
    });
  });

  it("resolveSecrets drops unresolved refs rather than leaking the token", () => {
    const resolved = store.resolveSecrets({
      Authorization: "secret://missing/Authorization",
      Accept: "*/*",
    });
    expect(resolved).toEqual({ Accept: "*/*" });
    expect(resolved.Authorization).toBeUndefined();
  });

  it("deleteToolSecrets removes every secret for a tool only", () => {
    store.setSecret("t1", "A", "a");
    store.setSecret("t1", "B", "b");
    store.setSecret("t2", "C", "c");

    store.deleteToolSecrets("t1");
    expect(store.hasSecret("t1", "A")).toBe(false);
    expect(store.hasSecret("t1", "B")).toBe(false);
    expect(store.hasSecret("t2", "C")).toBe(true);
  });
});
