# Local Embeddings + Vector Graph — Implementation Plan

**Status:** in-progress
**Started:** 2026-06-18
**Scope:** Offline-first semantic features for Notes + Knowledge Graph using
`nomic-ai/nomic-embed-text-v1.5` via `@xenova/transformers`, running as a
packaged HTTP binary so both the Electron main process and the MCP server
can call it.

## Architecture

```
Electron Main ─────┐                         ┌──── MCP Server (pkg binary)
                   │ HTTP 127.0.0.1:<free>    │ fetch()
embeddingsClient ──┴──► cairn-embeddings ◄───┘
   (spawn+health,      (pkg-packaged Node 22 binary;
    kill on quit)        owns ONNX Runtime, exposes
                         POST /embed {texts, task} → {vectors}
                         GET  /health)
                         ↓
   nomic-ai/nomic-embed-text-v1.5 (int8 quantised, ~87 MB)
                         ↓
   SQLite writes go through whichever process made the call:
     - Electron main → electron/db/queries.ts (Electron ABI db handle)
     - MCP          → mcp/db.ts (Node 22 ABI db handle)
```

Mirrors the existing `llama-server.ts` spawn/findFreePort/checkHealth/dispose
pattern at `main.ts:303-313` (`before-quit`). The MCP server reaches the binary
via HTTP `fetch()` — no second wire protocol to maintain.

## Nomic task prefixes (correctness-critical)

Prefix **must** be prepended to the raw input string **before** tokenisation.

| Task              | Prefix               | Usage                                  |
|-------------------|----------------------|----------------------------------------|
| `search_document` | `search_document: `  | Indexing notes                         |
| `search_query`    | `search_query: `     | Sidebar "Semantic Hubs" similarity     |
| `clustering`      | `clustering: `       | Graph projection / UMAP                |

## Storage shape

`note_embeddings` table (v17 migration in `schema.ts`):

```
note_id        TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE
workspace_id   TEXT NOT NULL
model          TEXT NOT NULL          -- e.g. "nomic-ai/nomic-embed-text-v1.5"
task           TEXT NOT NULL          -- "search_document" | "clustering"
content_hash   TEXT NOT NULL          -- sha256 of embedded text → dirty-check
vector         TEXT NOT NULL          -- JSON number[768]; swap for BLOB at vec0
embedded_at    TEXT NOT NULL
dim_x          REAL                   -- UMAP projection (clustering task only)
dim_y          REAL
proj_stale     INTEGER NOT NULL DEFAULT 1
```

Indexes: `idx_emb_ws(workspace_id)`, `idx_emb_proj(proj_stale)`.

Bridge to eventual `sqlite-vec` swap: the `vector` column is JSON-in-TEXT,
which fits the existing `db-mappers.ts` `parseJsonArray` convention. The
swap is one migration: copy JSON → BLOB → `vec0` virtual table + drop TEXT
column. `cosine.ts` API does not change.

## Tasks

### Phase 1 — Core (Electron main-side)
- [x] 1a. Install deps: `@xenova/transformers`, `onnxruntime-node`, `umap-js`
- [x] 1b. `electron/embeddings/types.ts` — Zod request/response + manifest types
- [x] 1c. `electron/embeddings/cosine.ts` — pure typed cosine + topK
- [x] 1d. `electron/embeddings/nomic.ts` — task prefixes + embed wrapper
- [x] 1e. `electron/embeddings/projection.ts` — UMAP runner (pure ESM, no bsqlite)

### Phase 2 — Worker binary (packaged, HTTP)
- [x] 2a. `electron/embeddings/server.ts` — HTTP entry (`/embed`, `/health`)
- [x] 2b. `scripts/build-embeddings-binary.js` — pkg bundler (clone of build-mcp-binary.js)
- [x] 2c. `electron/embeddings/client.ts` — spawn + findFreePort + checkHealth + dispose
- [x] 2d. `electron/embeddings/manifest.ts` — model registry + default-model.json
       (clone of `llama-server.ts` lines 26–169 + 222–455)

### Phase 3 — DB layer
- [x] 3a. v17 migration in `electron/db/schema.ts` (after v16)
- [x] 3b. Query helpers in `electron/db/queries.ts`:
       `upsertNoteEmbedding`, `getNoteEmbedding`, `getAllEmbeddingsForWorkspace`,
       `getStaleProjectionIds`, `upsertProjection`
- [x] 3c. `ensureEmbeddingsTable(db)` in `electron/mcp/db.ts`
       (MCP doesn't call `applySchema`; mirrors `ensureMcpActiveWritesTable`)

### Phase 4 — IPC + preload
- [x] 4a. `electron/ipc/embeddings-handlers.ts`:
       `db:embeddings:reindex` (write), `db:embeddings:search` (read),
       `db:embeddings:recomputeProjections` (read),
       `embeddings:status`, `embeddings:models:list|install|remove|setDefault`,
       `embeddings:download-progress` event
- [x] 4b. Register `registerEmbeddingsHandlers(ctx)` in `handlers.ts:52`
- [x] 4c. Add `db:embeddings:search`, `db:embeddings:recomputeProjections` to
       `readChannels` in `registry.ts:35-53`
- [x] 4d. `electron/preload.ts` — add `embeddings` namespace (mirror `llama`)

### Phase 5 — Settings (model management UI)
- [x] 5a. Extend `CachedConfig` in `electron/lib/config-cache.ts` with
       `embeddingsConfig?` + `saveCachedConfig("embeddings", ...)`
- [x] 5b. Add `app:{get,save}EmbeddingsSettings` to
       `electron/ipc/settings-handlers.ts`
- [x] 5c. Extend `AIConfig` (or new `EmbeddingsConfig`) in
       `src/store/slices/ui.ts` — dual-write pattern mirrors `setAIConfig:167-176`
- [x] 5d. Hydrate embeddings config in `src/store/index.ts:hydrateFromElectron`
- [x] 5e. New `src/components/settings/EmbeddingsSettings.tsx`
       (clone of `AISettings.tsx` model manager, lines 567–726)
- [x] 5f. Add `"embeddings"` section in `settings-view.tsx` (union + nav + render)

### Phase 6 — Knowledge Graph extensions
- [x] 6a. Add `"semantic"` to `GraphEdgeType` in `src/types/index.ts:276`
- [x] 6b. Mirror in local `EdgeType` at `electron/db/graph-queries.ts:41`
- [x] 6c. Push `"semantic"` into `autoTypes` array (pass 6)
- [x] 6d. Add similarity block in `computeAutoRelationships` (after keyword block):
       `SEMANTIC_THRESHOLD = 0.78`, uses `getAllEmbeddingsForWorkspace("search_document")`
- [x] 6e. Add `"semantic"` to `DEFAULT_GRAPH_FILTERS.edgeTypes` and `edgeTypeLabel`
       in `src/store/slices/graph.ts`
- [x] 6f. `ForceGraphCanvas.tsx:34` — `edgeColor()` case for `"semantic"`
- [x] 6g. `RadialTreeCanvas.tsx:71` — `crossEdgeColor()` case for `"semantic"`
- [x] 6h. Semantic opacity slider in `KnowledgeGraphView.tsx:~300` (next to Spacing)

### Phase 7 — Note editor (Semantic Hubs panel)
- [x] 7a. `src/hooks/useDebouncedValue.ts` — generic hook
- [x] 7b. `src/components/notes/SemanticHubsPanel.tsx` — top-5 adjacent notes
- [x] 7c. Wire into `note-editor.tsx:842` (flex row with editor + panel)
- [x] 7d. 1200ms semantic debounce ref in `handleContentChange`, cleared in `flushPending`

### Phase 8 — Build + verify
- [x] 8a. `package.json` deps + esbuild externals + new compile target for the worker
- [x] 8b. `main.ts:~173` — bootstrap (lazy spawn on first IPC request)
- [x] 8c. `main.ts:~310` — `embeddingsClient.dispose()` in `before-quit`
- [x] 8d. `npm run type-check:all` — must pass
- [x] 8e. `npm run compile` — must produce all bundles
- [x] 8f. Vitest tests: `cosine.test.ts`, `projection.test.ts`, `nomic.test.ts`

## Critical implementation notes (gotchas)

1. **Nomic prefix before tokenisation.** `nomic.ts:withNomicPrefix` runs on the
   raw string before the pipeline call. Never feed the worker pre-tokenized input.
2. **`normalize: true` at pipeline output.** Cosine becomes dot product; `cosine.ts`
   skips the L2 division. Guard behind a fast path: assume normalized, fall back if
   magnitude ≠ 1 within ε.
3. **v17 migration's `vector TEXT (JSON)` is a deliberate bridge** to `sqlite-vec`.
   Don't bake `JSON.parse` into call sites — funnel through `queries.ts` accessors.
4. **MCP server can read/write embeddings but must NOT construct a `Database` with
   the wrong ABI.** It uses its existing Node-22-ABI handle from `mcp-server.ts:140`.
   `note_embeddings` table must be ensured inline in `mcp/db.ts` because MCP does
   not call `applySchema`. Symmetric to `ensureMcpActiveWritesTable`.
5. **`semantic` edge weight handling in renderer.** The `edgeFingerprint` memo at
   `ForceGraphCanvas.tsx:139-155` re-simulates on any edge-set change. The
   `semanticThreshold` slider filters inside the memo so it trims the data the
   simulation sees (not just a visual filter).
6. **1200ms semantic debounce > 2× the 300ms save debounce.** Every semantic search
   runs against content already saved to SQLite. `flushPending` clears both timers.
7. **esbuild + template-literal gotcha** (AGENTS.md): backticks inside template
   literals must be unescaped at the template level.
8. **`zod` import style** in all new Electron files: `import * as z from "zod"`).
9. **CSS** all colours via `var(--token)` / `color-mix(...)` — never raw rgba or
   Tailwind colour names. SVG `fontSize` × `useFontScale()`.
10. **No comments unless explicitly requested** (AGENTS.md).
