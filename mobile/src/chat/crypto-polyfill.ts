/**
 * Minimal Web Crypto shim for the MCP OAuth flow.
 *
 * The MCP SDK's OAuth path uses `pkce-challenge`, which reads
 * `globalThis.crypto.getRandomValues` + `globalThis.crypto.subtle.digest(
 * "SHA-256", …)` to build the PKCE verifier/challenge. React Native / Hermes
 * ships neither `globalThis.crypto` nor a WebCrypto `subtle`, so without this the
 * OAuth flow throws at `startAuthorization` (bundles fine, fails at runtime).
 *
 * We back the two operations pkce-challenge actually needs with `expo-crypto`
 * (native, cryptographically secure). This is NOT a full WebCrypto polyfill —
 * only `getRandomValues` and `subtle.digest` are provided, which is all the PKCE
 * path uses. Installed idempotently; safe to import more than once.
 *
 * Import this once, as early as possible (top of app/_layout.tsx), before any
 * OAuth code runs.
 */

import * as ExpoCrypto from "expo-crypto";

interface MinimalSubtle {
  digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer>;
}

function installCryptoPolyfill(): void {
  // Use a loose shape here: the ambient DOM `Crypto`/`SubtleCrypto` types demand
  // a full WebCrypto surface we deliberately don't implement (only the two PKCE
  // ops). Cast through unknown so we can install a partial, framework-free shim.
  const g = globalThis as unknown as {
    crypto?: {
      getRandomValues?: (array: ArrayBufferView | null) => ArrayBufferView | null;
      subtle?: MinimalSubtle;
      randomUUID?: () => string;
    };
  };

  if (!g.crypto) {
    Object.defineProperty(g, "crypto", { value: {}, configurable: true, writable: true });
  }
  const crypto = g.crypto!;

  if (typeof crypto.getRandomValues !== "function") {
    crypto.getRandomValues = (array: ArrayBufferView | null): ArrayBufferView | null => {
      if (array == null) return array;
      ExpoCrypto.getRandomValues(array as unknown as Parameters<typeof ExpoCrypto.getRandomValues>[0]);
      return array;
    };
  }

  if (typeof crypto.randomUUID !== "function") {
    crypto.randomUUID = () => ExpoCrypto.randomUUID();
  }

  if (!crypto.subtle || typeof crypto.subtle.digest !== "function") {
    const subtle: MinimalSubtle = {
      async digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
        const name = typeof algorithm === "string" ? algorithm : algorithm.name;
        if (name !== "SHA-256") {
          throw new Error(`crypto.subtle.digest polyfill only supports SHA-256 (got ${name}).`);
        }
        const bytes =
          data instanceof Uint8Array
            ? data
            : ArrayBuffer.isView(data)
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : new Uint8Array(data as ArrayBuffer);
        return ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, bytes);
      },
    };
    crypto.subtle = subtle;
  }
}

installCryptoPolyfill();
