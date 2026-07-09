/**
 * Client-side token counting for the chat context ring.
 *
 * Uses js-tiktoken's pure-JS `lite` build with the o200k_base rank (the encoder
 * for gpt-4o / o200k-family models) — no WASM, works under Hermes. It's the
 * right encoder for OpenAI models and a good-enough approximation for others
 * (Rork), which is all a context-fill gauge needs.
 *
 * The rank table is ~loaded lazily on first use so the ~2MB JSON never touches
 * startup — only when a provider without server-reported usage needs an estimate.
 */

import { Tiktoken } from "js-tiktoken/lite";

let enc: Tiktoken | null = null;

function encoder(): Tiktoken {
  if (!enc) {
    // Required lazily so the rank JSON is excluded from the startup bundle path.
    // The rank is the module's default export under ESM but a direct object
    // under the CJS build Metro resolves — handle both.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy-load the ~2MB rank table only on first use
    const mod = require("js-tiktoken/ranks/o200k_base");
    const o200k = mod?.default ?? mod;
    enc = new Tiktoken(o200k);
  }
  return enc;
}

/** Token count for a piece of text (o200k_base). 0 for empty. */
export function countTextTokens(text: string): number {
  if (!text) return 0;
  try {
    return encoder().encode(text).length;
  } catch {
    // Never let token counting break a turn — fall back to a rough chars/4.
    return Math.ceil(text.length / 4);
  }
}
