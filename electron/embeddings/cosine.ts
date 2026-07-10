/**
 * Re-export of the shared vector math. The implementation lives in
 * `shared/embeddings/vector.ts` so desktop and mobile score embeddings with
 * identical arithmetic; this thin shim keeps the existing `./cosine` relative
 * imports (and the cosine/bench test suites) working.
 */
export { cosine, topK, dotNormalized, magnitude, toFloat32 } from "../../shared/embeddings/vector";
