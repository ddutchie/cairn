/**
 * Types for the on-device Apple embeddings native module (`apple-embeddings`).
 * These mirror the Swift shapes in ios/AppleEmbeddingsModule.swift.
 *
 * Backed by NaturalLanguage's `NLContextualEmbedding` (iOS 17+): a BERT-style
 * contextual model that runs fully on-device. Unlike the desktop bge-small
 * pipeline, these vectors live in Apple's own embedding space — they are NOT
 * interchangeable with desktop embeddings, so the mobile index is built and
 * queried entirely on-device and never synced.
 */

/**
 * Metadata about the loaded contextual embedding model. `dimension` is fixed by
 * the model and drives the stored vector width; callers must treat a change in
 * `dimension` or `modelIdentifier` as an index invalidation (re-embed all).
 */
export interface AppleEmbeddingsInfo {
  /** Vector dimensionality produced by mean-pooling the model output. */
  dimension: number;
  /** Stable id of the underlying NLContextualEmbedding model. */
  modelIdentifier: string;
  /** Model asset revision — bump means the vector space may have shifted. */
  revision: number;
  /** Max tokens the model consumes per call; longer text is chunked in JS. */
  maximumSequenceLength: number;
}

/**
 * Stable public error codes mirrored on the Swift side. Use `code` for control
 * flow; `message` is display/debug text, not a compatibility contract.
 */
export const AppleEmbeddingsErrorCodes = {
  Unsupported: "UNSUPPORTED",
  AssetsUnavailable: "ASSETS_UNAVAILABLE",
  EmbedFailed: "EMBED_FAILED",
} as const;

export type AppleEmbeddingsErrorCode =
  (typeof AppleEmbeddingsErrorCodes)[keyof typeof AppleEmbeddingsErrorCodes];

/** An Error thrown by the native module, carrying a stable `code`. */
export class AppleEmbeddingsError extends Error {
  code: AppleEmbeddingsErrorCode;
  constructor(code: AppleEmbeddingsErrorCode, message: string) {
    super(message);
    this.name = "AppleEmbeddingsError";
    this.code = code;
  }
}
