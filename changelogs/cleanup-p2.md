## Cleanup (P2 — IPC handlers.ts decomposition)

Architectural-deep-dive cleanup (see `docs/cleanup/`). Phase P2 splits the
1054-line god-file `electron/ipc/handlers.ts` into per-domain registrars, following
the same pattern `ipc/agent.ts` and `ipc/pi-agent.ts` already used. `handlers.ts`
becomes a 170-line orchestrator that just calls each module's `registerXxxHandlers()`.

No behaviour changes — every IPC channel is registered exactly once, with identical
arguments and return shapes. All 430 tests pass (including the IPC test suites
`handlers.test.ts`, `agent.test.ts`, `chat-executor.test.ts`).

### New shared module

| File | LOC | Responsibility |
|------|----:|----------------|
| `electron/ipc/result-helpers.ts` | 53 | `ok`, `err`, `handle`, `getProjectName`, and the `DbContext` interface (re-exported from `handlers.ts` for backwards compat with `mobile-server.ts:8`) |

### New pure-lib modules (extracted from inlined templates)

| File | LOC | Responsibility |
|------|----:|----------------|
| `electron/lib/pdf-template.ts` | 67 | `buildPdfHtml(title, body)` — the 60-line `prose-cairn` light-theme HTML template that was inlined inside the `app:exportNotePdf` handler |
| `electron/lib/url-metadata.ts` | 66 | `fetchUrlMetadata(url)` — the OG-tag scraper + `net.fetch` + 50 KB head-cutoff logic that was inlined inside `db:flow:url:fetch` |

### New per-domain IPC registrars

| File | LOC | Channels registered |
|------|----:|----------------------|
| `electron/ipc/pdf-export.ts` | 60 | `app:exportNotePdf` |
| `electron/ipc/url-metadata.ts` | 17 | `db:flow:url:fetch` |
| `electron/ipc/flow-handlers.ts` | 226 | `db:flow:get`, `db:flow:node:{create,update,delete,summarize}`, `db:flow:edge:{create,delete}` (incl. the 110-line inlined BFS + LLM call) |
| `electron/ipc/db-handlers.ts` | 215 | `db:snapshot`, `db:hasData`, `db:mcpQuery`, `db:workspace:*`, `db:project:*`, `db:note:*`, `db:column:*`, `db:card:*`, `db:cards:archive-done`, `db:card:{addBlocker,removeBlocker,ready}`, `db:tag:*`, `app:openExternal`, `app:revealNote`, `app:uploadAsset`, `app:revealAssets` |
| `electron/ipc/chat-db-handlers.ts` | 26 | `db:chat:threads`, `db:chat:messages`, `db:chat:upsertThread`, `db:chat:addMessage`, `db:chat:clearThreadMessages`, `db:chat:deleteThread` |
| `electron/ipc/pi-session-handlers.ts` | 18 | `db:piSession:{list,create,delete,messages,saveMessages}` |
| `electron/ipc/llama-handlers.ts` | 64 | `llama:models:{list,install,remove,clearInactive}`, `llama:binary:{install,check-update}`, `llama:server:{start,stop,status,setDefault}` |
| `electron/ipc/ai-handlers.ts` | 56 | `ai:localLLMStatus`, `ai:generatePrd` |
| `electron/ipc/graph-handlers.ts` | 31 | `db:graph:get`, `db:graph:neighbors`, `db:graph:recompute` |
| `electron/ipc/mobile-handlers.ts` | 35 | `mobile:status`, `mobile:saveSettings`, `mobile:regeneratePin` |
| `electron/ipc/migration-handlers.ts` | 33 | `app:checkMigrations`, `app:runMigration` |
| `electron/ipc/settings-handlers.ts` | 35 | `app:{get,save}{AiSettings,AgentSettings,Theme,FontScale}` |

### Slimmed-down orchestrator

`electron/ipc/handlers.ts`: **1054 → 170 lines** (−884 LOC).

- `registerIpcHandlers(ctx)` — was 619 lines, now 13 lines calling 8 per-domain
  registrars (DB, ChatHandler, ChatDb, PiSession, Flow, Ai, Llama, Graph).
- `registerAppHandlers(ctx, userDataPath, updateTrayBadge, onReinitialise, onBadgeClear)`
  — was 350 lines, now 157 lines. Keeps the tightly-app-lifecycle-tied handlers
  (`app:selectWorkspaceFolder`, `app:getWorkspacePath`, `app:setTheme` with its
  Windows title-bar-overlay code, `app:initWorkspace`, `app:mcpServerPath`,
  `app:latestChangelog`, `app:reset`, `app:relaunch`, `updater:install`,
  `mcp:markNotificationsRead`) and delegates the rest to
  `registerMobileHandlers` / `registerPdfExportHandler` / `registerUrlMetadataHandler`
  / `registerMigrationHandlers` / `registerSettingsHandlers`.

### Code cleanups rolled into P2

- **`getProjectName` covers the previous `getProjectName` duplication.** The old
  helper inlined `SELECT name FROM projects WHERE id = ?`; the new one in
  `result-helpers.ts` delegates to `q.getProjectById` (queries.ts) which already
  exists. Same observable behaviour, one fewer SQL call site.
- **`db:chat:clearThreadMessages`** kept its inline SQL DELETE (with a TODO to
  promote to `q.clearChatThreadMessages` in a follow-up). Considered in scope as a
  P2-5 question; decided to defer to avoid touching `queries.ts` API surface mid-split.
- **Pattern for `db:flow:*:summarize`:** the BFS is intentionally left inlined in
  `flow-handlers.ts` (not unified with `q.getResolvedFlow` in `queries.ts`). They
  share a *similar* edge-iteration shape but different semantics (one walks the
  graph collecting `nodeId`s skipping `ai_summary`; the other resolves
  `resolvedTitle`/`resolvedSnippet` for `note_ref`/`task_ref` nodes + computes
  spatial bounds + group slots). A shared helper would have to take several
  strategy parameters and the result would be less readable than the two
  straightforward implementations side by side. **Track for a P5+ follow-up** if
  a third callsite ever appears.

### What did NOT change

- Channel names, argument shapes, and return shapes — every IPC channel a
  renderer/preload calls is registered with the exact same `args` and `IpcResult<T>`
  contract.
- The `DbContext` interface (`{ db, workspacePath, getWin }`) — re-exported from
  `result-helpers.ts` so `electron/lib/mobile-server.ts`'s existing
  `import type { DbContext } from "../ipc/handlers"` continues to work.
- `electron/main.ts` call sites (`registerIpcHandlers(ctx)` at line 188,
  `registerAppHandlers(ctx, userDataPath, ...)` at line 286) — unchanged.

## Verification

- `npm run type-check:all` — clean (renderer + electron).
- `npm run lint -- --max-warnings 0` — clean (including the new per-domain files;
  only remaining explicit `any` use is the `DbRow` alias in `flow-handlers.ts`,
  scoped to a single declaration with a single eslint-disable).
- `npm run compile` — clean (esbuild resolves the new module structure; the dist
  bundles are unchanged in behaviour).
- `npm test` — **430 tests pass across 18 files** (incl. `handlers.test.ts`,
  `agent.test.ts`, `chat-executor.test.ts`, the MCP server tests, and queries tests).
