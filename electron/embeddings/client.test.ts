/**
 * Tests for `resolveEmbeddingModelId` — the model id validator that
 * sanitises persisted caches and `default-model.json` against the
 * supported models registry.
 *
 * Why this matters: in v2.1.4 (Nomic → bge-small swap) the persisted cache
 * still referenced the pruned nomic model, IPC handlers forwarded it to the
 * embeddings server, and the server crashed trying to load deleted onnx
 * files. The resolver filters any stale id against the supported registry
 * before it can be used in a request.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the electron module so manifest.ts (which imports `app` for
// getPath("userData")) can be loaded in a Node test environment.
// `vi.hoisted` runs the factory before any imports so the mock is in place
// by the time manifest.ts (which uses `app.getPath("userData")` at module
// load) is first imported.
const tmpDir = vi.hoisted(() => "/tmp/cairn-client-test");
vi.mock("electron", () => ({
  app: {
    getPath: (key: string) => `${tmpDir}/${key}`,
    isReady: () => true,
  },
}));

import * as client from "./client";
import { SUPPORTED_EMBEDDING_MODELS } from "./manifest";
import { EMBED_MODEL_ID } from "./types";

describe("resolveEmbeddingModelId", () => {
  beforeEach(() => {
    // Supported registry is the source of truth — bge-small is the only
    // supported model after the v2.1.4 migration.
    expect(SUPPORTED_EMBEDDING_MODELS[EMBED_MODEL_ID]).toBeDefined();
    expect(SUPPORTED_EMBEDDING_MODELS["nomic-ai/nomic-embed-text-v1.5"]).toBeUndefined();
  });

  it("returns the supported candidate when given one", () => {
    expect(client.resolveEmbeddingModelId(EMBED_MODEL_ID)).toBe(EMBED_MODEL_ID);
  });

  it("skips over an unsupported id and falls back to the next candidate", () => {
    const stale = "nomic-ai/nomic-embed-text-v1.5";
    expect(client.resolveEmbeddingModelId(stale, EMBED_MODEL_ID)).toBe(EMBED_MODEL_ID);
  });

  it("returns the default when every candidate is unsupported", () => {
    expect(
      client.resolveEmbeddingModelId("nomic-ai/nomic-embed-text-v1.5", "foo/bar"),
    ).toBe(EMBED_MODEL_ID);
  });

  it("returns the default when all candidates are nullish", () => {
    expect(client.resolveEmbeddingModelId(undefined, null, "")).toBe(EMBED_MODEL_ID);
  });

  it("returns the default when called with no candidates", () => {
    expect(client.resolveEmbeddingModelId()).toBe(EMBED_MODEL_ID);
  });

  it("prefers an explicit supported arg over a stale cached id", () => {
    expect(
      client.resolveEmbeddingModelId(
        EMBED_MODEL_ID,               // explicit (renderer-supplied)
        "nomic-ai/nomic-embed-text-v1.5", // cached stale
      ),
    ).toBe(EMBED_MODEL_ID);
  });
});
