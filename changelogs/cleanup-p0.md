## Cleanup (P0 — Hygiene & Safety Net)

Architectural-deep-dive cleanup (see `docs/cleanup/`). Phase P0 removes dead code
and reconciles the native-binding / type-checking setup so later phases can be done
safely. No behaviour changes.

### Removed (dead code)

- **`mcp-native/` folder** deleted. The system-Node build was removed in v0.3.8 but
  the folder lingered; no source code referenced it (only stale `dist-electron/` and
  `dist-mcp/` artifacts, also regenerated).
- **`pkg-native/better_sqlite3_node25.node`** deleted. No references anywhere in the
  repo (scripts, electron source, configs). Stale binary from an earlier pkg target.
- **`scripts/check-tool-parity.ts`** + **`electron/ipc/tool-parity.test.ts`** deleted.
  Both referenced the `TOOL_DEFINITIONS` constant which was refactored away into
  `electron/lib/tool-schemas.ts` (`TOOL_SCHEMAS`). Never invoked by `package.json` or
  CI; gave false confidence.
- **`dist-electron/mcp-server.js`** + **`dist-mcp/mcp-server.js`** deleted. Stale
  artifacts from an older build pipeline (the current compile produces
  `dist-mcp/mcp-server.bundle.js`). They still referenced the deleted `mcp-native/`.
- **`src/components/graph/GraphAIPanel.test.ts`** renamed to
  **`graph-ai-utils.test.ts`**. The test was *not* dead — it imports and tests
  `./graph-ai-utils` (`wikilinkAlreadyExists` + `buildGraphContext`, 16 passing
  tests). Only the filename implied an orphaned `GraphAIPanel.tsx` component that
  doesn't exist.

### Native binding setup

- **`vitest-sqlite-shim.cjs` now honors `process.env.BETTER_SQLITE3_BINDING`**
  (falling back to `vitest-native/better_sqlite3.node`). Previously the shim
  hardcoded the path and the env var set in `vitest.config.ts` was silently ignored.
- **`vitest.config.ts` env var repointed at `vitest-native/`** (the actually-correct
  system-Node ABI build), not `pkg-native/` (which holds the Node 22 ABI for the
  pkg-bundled MCP binary). The misleading comment claiming "pkg-native/ always has
  the system Node ABI" is corrected.
- **`vitest-native/` folder kept.** Despite looking redundant with `pkg-native/`, the
  two hold *different* ABIs in general: `pkg-native/` is Node 22 (pkg binary target),
  `vitest-native/` is whatever system Node the developer runs (CONTRIBUTING.md:55
  documents three distinct ABIs). They only coincide on Node 22; consolidating would
  silently break vitest for developers on Node ≠ 22 (there is no `engines` or `.nvmrc`
  pin in the repo).

### Type-checking

- **`tsconfig.mcp.json` removed.** It type-checked only `electron/mcp-server.ts` as a
  single root file, which gives superficial coverage (TypeScript doesn't pull
  transitive imports during a no-emit check of one root).
- **`tsconfig.electron.json`** now removes the unused `@shared/*` path alias.
- **New `type-check:electron` and `type-check:all` npm scripts.** Previously only
  `tsc --noEmit` (renderer) existed; electron code was never type-checked.
- **CI `type-check` job** now runs `npm run type-check:all`, covering both the
  renderer and the electron/mcp codebase. AGENTS.md updated to instruct
  `npm run type-check:all` after changes.

### Build

- **esbuild target bumped from `node20` → `node22`** in `package.json` (`compile` + `compile:watch`) and `scripts/build.js` (main+preload production build). Electron 41 ships Node 22 and the MCP bundle runs under Node 22; the previous `node20` was stale.

### Type-check fixes (P0-3 detail)

**`electron/` had 142 pre-existing type errors** that were never surfaced because CI only ran `tsc --noEmit` (renderer-only `tsconfig.json`). All 142 are now fixed and the electron type-check is green.

**Architectural fix — `IpcHandler` was too strict (resolved 80 errors).**
`electron/ipc/registry.ts` declared `IpcHandler = (event: unknown, ...args: unknown[]) => unknown`. By contravariance, every handler with a destructured typed second arg (e.g. `(_e, { id }: { id: string })`) was rejected. Made the type **generic** over the args tuple, and split event typing for the two ipc surfaces: `IpcHandleHandler<T>` (event `Electron.IpcMainInvokeEvent`) for `registerIpcHandle` and `IpcOnHandler<T>` (event `Electron.IpcMainEvent`) for `registerIpcOn`. The erased `IpcHandler<T>` remains the internal storage type. This properly types both `event.sender` accesses and destructured args, with no `any`.

**Mechanical fixes (resolved 17 errors).** Missing imports in `electron/mcp/db.ts` (`Database`, `newId`, `ts`) and `electron/lib/tools.ts` (`ToolName`); `https.ClientRequest` → `http.ClientRequest` in `electron/lib/llama-server.ts` (Node 22 types); widened `chatOnlySet`/`agentExcluded` to `Set<string>` in `context-audit.test.ts` (filters `Object.keys()` results).

**Handler arg typing (resolved 25 errors).** `electron/ipc/handlers.ts` forwarding handlers annotated with `Parameters<typeof q.fn>[1]` for type-safe IPC-boundary forwarding; two `reqConfig` locals widened to optional fields matching `CachedConfig.aiConfig`'s shape (downstream already used `?.` + fallbacks); `electron/mcp/tools/tasks.ts` row typed as `{ archived_at?: string | null; title?: string } | undefined`.

**Real type bugs fixed (resolved 12 errors).**
- `electron/ipc/pi-agent.ts`: `PiAgentPromptRequest.config` and `PiAgentApprovePlanRequest.config` were missing `provider?` (the handler checks `req.config?.provider === "localllm"`).
- `electron/lib/config-cache.ts`: `CachedConfig.agentConfig` was missing `maxSteps?`/`temperature?` (the pi-agent merge reads `cached.maxSteps`/`cached.temperature`). Note `saveCachedConfig("agent")` still doesn't persist these two — a behavioural follow-up (cache them, or drop the dead fallback) is tracked in `findings.md`.
- `electron/db/graph-queries.ts`: the local `GraphNode.meta` type was missing `isArchived?` (the code adds `isArchived: !!(c.archived_at)` to card nodes). This is a second instance of the type-duplication-across-boundary issue noted for `wikilink-parser` in `findings.md §2.8` — a P1+ consolidation candidate.
- `electron/lib/mobile-server.ts`: typed the `clientSocket.on("error")` callback param as `Error`.

### Docs

- **AGENTS.md** corrected: the "mcp-server.ts uses inlined SQL only due to Node ABI
  boundary" claim is stale. `mcp/tools/codebase.ts` already imports
  `* as q from "../../db/queries"` and works in the bundle — the only ABI-sensitive
  operation is `new Database(dbPath, { nativeBinding })` which happens once in
  `mcp-server.ts`. This unblocks the P1 SQL-consolidation phase.
- **AGENTS.md** corrected: the seven analytics canvases live in
  `src/components/graph/`, not `src/components/insights/` (only `InsightsView.tsx`
  lives in `insights/`).

## Verification

- `npm run type-check:all` — clean (renderer + electron).
- `npm run lint -- --max-warnings 0` — clean.
- `npm run compile` — clean (esbuild node22 targets).
- `npm test` — **430 tests pass across 18 files** (including the renamed `graph-ai-utils.test.ts`).
