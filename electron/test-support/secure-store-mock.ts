/**
 * Shared secure-store test mocks (A1/F19). The secrets store persists through
 * `electron.safeStorage` + `fs`, so tests stub both with an in-memory file
 * backing. Use inside `vi.mock` factories via dynamic import (vitest hoists
 * `vi.mock`, so a static import cannot be referenced in the factory):
 *
 *   vi.mock("electron", async () =>
 *     (await import("../test-support/secure-store-mock")).electronMock("/tmp/my-test"));
 *   vi.mock("fs", async () => (await import("../test-support/secure-store-mock")).fsMock());
 *
 * Reset state with `resetVirtualFiles()` in `beforeEach` (the store is
 * module-level so every test starts empty).
 */
import { vi } from "vitest";

/** In-memory file backing shared by the `fs` mock. Mutated in place. */
export const virtualFiles: Record<string, string> = {};

/** Clear the in-memory backing. Call in `beforeEach`. */
export function resetVirtualFiles(): void {
  for (const key of Object.keys(virtualFiles)) delete virtualFiles[key];
}

/** Reversible "encryption" so round-trips are verifiable in tests. */
const codec = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf-8"),
  decryptString: (b: Buffer) => b.toString("utf-8").replace(/^enc:/, ""),
};

/** Stub `electron` with a fake userData dir + reversible safeStorage. */
export function electronMock(userData: string) {
  return {
    app: {
      isReady: () => true,
      getPath: (key: string) => (key === "userData" ? userData : `/mock/${key}`),
      on: () => {},
      setAsDefaultProtocolClient: () => true,
    },
    shell: { openExternal: vi.fn(() => Promise.resolve()) },
    safeStorage: { ...codec },
  };
}

/** Stub `fs` (default export) backed by {@link virtualFiles}. */
export function fsMock() {
  return {
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
  };
}
