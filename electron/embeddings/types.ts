import * as z from "zod";
import type {
  EmbeddingModelManifestEntry,
  EmbeddingsConfig,
  EmbeddingsStatus,
} from "../../shared/types/embeddings";
// Canonical config lives in shared (single source); re-exported here so
// existing electron imports keep working. Do not re-declare.
export type { EmbeddingModelManifestEntry, EmbeddingsConfig, EmbeddingsStatus };

export type EmbedTask = "search_document" | "search_query" | "clustering";

export const EMBED_MODEL_ID = "Xenova/bge-small-en-v1.5";

export const EMBED_DIM = 384;

export const EmbedRequest = z.object({
  texts: z.array(z.string()).min(1).max(64),
  task: z.enum(["search_document", "search_query", "clustering"]),
  model: z.string().optional(),
});

export type EmbedRequestT = z.infer<typeof EmbedRequest>;

export const EmbedResponse = z.object({
  vectors: z.array(z.array(z.number())),
  dim: z.number(),
  model: z.string(),
});

export type EmbedResponseT = z.infer<typeof EmbedResponse>;

export const HealthResponse = z.object({
  status: z.literal("ok"),
  model: z.string().nullable(),
  loaded: z.boolean(),
});

export type HealthResponseT = z.infer<typeof HealthResponse>;

export interface EmbeddingRecord {
  noteId: string;
  workspaceId: string;
  model: string;
  task: EmbedTask;
  contentHash: string;
  vector: number[];
  embeddedAt: string;
  dimX: number | null;
  dimY: number | null;
  projStale: number;
}

export type EmbeddedVector = {
  noteId: string;
  vector: Float32Array;
};



export const DEFAULT_EMBEDDINGS_CONFIG: EmbeddingsConfig = {
  enabled: false,
  modelId: EMBED_MODEL_ID,
};
