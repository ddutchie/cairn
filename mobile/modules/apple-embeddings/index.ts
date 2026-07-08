import { NativeModule, requireOptionalNativeModule } from "expo";

import type { AppleEmbeddingsInfo } from "./AppleEmbeddings.types";

export * from "./AppleEmbeddings.types";

/**
 * Native surface of the `apple-embeddings` module, backed by
 * NaturalLanguage's `NLContextualEmbedding` (iOS 17+). All API use is
 * `@available`-gated natively; the JS layer must call `isAvailable()` first and
 * fall back gracefully everywhere else (older iOS, Android, web, Expo Go).
 */
declare class AppleEmbeddingsNativeModule extends NativeModule {
  /**
   * True on iOS 17+ when a contextual-embedding model constructs for the
   * language — even if its assets aren't downloaded yet (they're fetched on
   * demand). Use this to decide whether to SHOW semantic-search UI.
   */
  isSupported(): boolean;
  /**
   * True when a contextual-embedding model can produce vectors right now
   * (supported OS + assets downloaded and loadable). May return false on first
   * launch until `ensureAssets()` has completed the on-device asset download.
   */
  isAvailable(): boolean;
  /** Human-readable reason when unavailable (empty when available). */
  unavailableReason(): string;
  /**
   * Model metadata (dimension, identifier, revision). Throws if the model can't
   * be constructed on this OS. Use `dimension` + `modelIdentifier` + `revision`
   * as the index-invalidation key.
   */
  info(): Promise<AppleEmbeddingsInfo>;
  /**
   * Ensure the model assets are present on-device, downloading them if needed.
   * Resolves true when assets are available, false otherwise. Safe to call
   * repeatedly; a no-op once loaded.
   */
  ensureAssets(): Promise<boolean>;
  /**
   * Embed a batch of strings into L2-normalised, mean-pooled vectors (one per
   * input). Returns a flat Float array of length `texts.length * dimension`
   * (row-major) to keep the bridge payload compact; the JS wrapper reshapes it.
   * Empty strings yield a zero vector.
   */
  embed(texts: string[]): Promise<number[]>;
}

/**
 * The native module, or null when it isn't present (Expo Go, web, Android, or a
 * build that didn't include it). Optional so importing never throws on
 * unsupported platforms — always guard with `isAppleEmbeddingsAvailable()`.
 */
export const AppleEmbeddings =
  requireOptionalNativeModule<AppleEmbeddingsNativeModule>("AppleEmbeddings");

/** Whether on-device Apple embeddings can run right now. */
export function isAppleEmbeddingsAvailable(): boolean {
  try {
    return AppleEmbeddings?.isAvailable() ?? false;
  } catch {
    return false;
  }
}

/**
 * Whether this device *supports* on-device embeddings (iOS 17+ with a model for
 * the language) — regardless of whether assets are downloaded yet. Use this to
 * gate whether to show semantic-search UI; the actual embed path calls
 * `ensureAssets()` to fetch assets on demand. Falls back to `isAvailable()` if
 * an older native build without `isSupported()` is present.
 */
export function isAppleEmbeddingsSupported(): boolean {
  try {
    if (!AppleEmbeddings) return false;
    const anyMod = AppleEmbeddings as unknown as { isSupported?: () => boolean };
    if (typeof anyMod.isSupported === "function") return anyMod.isSupported();
    return AppleEmbeddings.isAvailable();
  } catch {
    return false;
  }
}

/** Reason on-device embeddings are unavailable, for surfacing in the UI. */
export function appleEmbeddingsUnavailableReason(): string {
  try {
    if (!AppleEmbeddings) return "On-device semantic search isn't available in this build.";
    return AppleEmbeddings.unavailableReason() || "On-device embeddings are unavailable.";
  } catch {
    return "On-device semantic search isn't available on this device.";
  }
}

/**
 * Embed `texts` and reshape the flat native result into per-text Float32Array
 * rows of width `dim`. Returns [] when the module is unavailable so callers can
 * degrade to keyword search.
 */
export async function embedTexts(texts: string[], dim: number): Promise<Float32Array[]> {
  if (!AppleEmbeddings || texts.length === 0) return [];
  const flat = await AppleEmbeddings.embed(texts);
  // Fail fast on a malformed native payload rather than slicing partial/zero-
  // padded rows into Float32Array — those would be persisted to note_embeddings
  // and silently poison search results.
  const expected = texts.length * dim;
  if (flat.length !== expected) {
    throw new Error(`AppleEmbeddings.embed returned ${flat.length} values, expected ${expected} (${texts.length}×${dim})`);
  }
  const rows: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    rows.push(Float32Array.from(flat.slice(i * dim, i * dim + dim)));
  }
  return rows;
}
