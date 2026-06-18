# Cairn — Architectural Deep Dive: Findings

> Scope: codebase state on 2026-06-17 (v2.0.8). All line counts from `wc -l`.
> Goal: identify cleanup, complexity-reduction, and extraction opportunities.

This document is a survey of the codebase as-is. Concrete remediation work is sequenced in
`implementation-plan.md` in the same folder.

---

## 0. TL;DR — Top Issues by Impact

| # | Issue | Where | Estimated saving |
|---|-------|-------|-----------------|
| 1 | **~1000 lines of duplicated SQL** across the Electron↔MCP boundary (the boundary is fictional — see §5) | `electron/mcp/tools/*.ts`, `electron/mcp/db.ts` vs `electron/db/queries.ts` + `electron/db/graph-queries.ts` | ~1000 LOC |
| 2 | `electron/ipc/handlers.ts` is a 1054-line god-file mixing 7 domains + 3 large inline templates (BFS, PDF HTML, OG scraping) | `electron/ipc/handlers.ts` | 1 file → ~10 files |
| 3 | 6 god-components over 800 lines (worst: `note-editor.tsx` 1283, `notes-view.tsx` 1033, `flow-view.tsx` 1019, `agent/SessionPane.tsx` 1009) | `src/components/{notes,flow,agent,settings}/` | unblock further work |
| 4 | 7 analytics canvases with inconsistent adherence to their own shared scaffold; 4 separate definitions of priority color/weight (incl. a dead export) | `src/components/graph/` | ~150 LOC + consistency |
| 5 | Store hydration logic duplicated between `hydrate()` and `hydrateFromElectron()` (~50 lines of identical theme/font/ai/agent/hidden/chat-width restores) | `src/store/index.ts:155-361` | ~50 LOC |
| 6 | 8 modal components, no shared `<ModalShell>` (despite a Radix Dialog primitive existing) | across `components/` | ~200 LOC |
| 7 | 7 independent "message bubble" implementations across chat + agent (with byte-identical `CAIRN_*_ACTIONS` tables) | `AgentMessageBubble.tsx` + `chat-panel/ChatMessageBubble.tsx` | ~400 LOC |
| 8 | Stale `mcp-native/` folder (dead per changelog v0.3.8); orphaned `pkg-native/better_sqlite3_node25.node`; misleading `vitest.config.ts` env var (set but ignored by the shim) | repo root | 2 binaries (~4 MB) + env-var honesty |
| 9 | `tsconfig.mcp.json` (single-file, superficial coverage); CI `type-check` runs `tsc --noEmit` only — **electron code is never type-checked in CI** | `tsconfig*.json`, `.github/workflows/ci.yml` | correctness |
| 10 | Orphaned/dead tests: `src/components/graph/GraphAIPanel.test.ts` (no `GraphAIPanel.tsx`), `electron/ipc/tool-parity.test.ts` + `scripts/check-tool-parity.ts` (refer to removed `TOOL_DEFINITIONS`) | scattered | ~600 LOC + false confidence |

---

## 1. Repository Structure Overview

```
cairn/
├── src/                    # Next.js renderer (App Router, static export)
│   ├── app/                # layout.tsx + page.tsx (410-line shell)
│   ├── components/         # ~100 files, 11 subfolders
│   ├── hooks/              # 2 files (hooks are scattered — see §2.3)
│   ├── lib/                # 9 files + commands/ + markdown/
│   ├── store/              # index.ts + ipc.ts + slices/ (10 slices)
│   └── types/              # index.ts (single 379-line barrel) + electron.d.ts
├── electron/               # Main process + MCP server (separately bundled)
│   ├── main.ts             # 317 lines — clean orchestrator
│   ├── preload.ts          # 532 lines — single IPC API literal
│   ├── ipc/                # 6 files (handlers.ts = 1054 lines)
│   ├── db/                 # queries.ts (1244), graph-queries.ts (707), schema.ts (428)
│   ├── mcp/                # MCP server runtime (db.ts + tools/*)
│   ├── shared/             # cleanly shared modules (mappers, notes-io, text-utils)
│   ├── lib/                # 36 files (llama-server 997, mobile-server 770, pi-agent-loop 747)
│   └── mcp-server.ts      # 153 lines — entry point
├── scripts/                # build, rebuild, smoke-test, licenses
├── tests/                  # e2e/ + fixtures/
├── electron-native/        # better_sqlite3_electron.node  (live)
├── mcp-native/             # better_sqlite3_node.node      (DEAD)
├── pkg-native/             # better_sqlite3.node (+ _node25.node, likely unused)
├── vitest-native/          # better_sqlite3.node (system-Node ABI, for vitest)
├── tsconfig.json           # renderer (next)
├── tsconfig.electron.json  # electron
└── tsconfig.mcp.json       # mcp (single-file, superficial)
```

## 2. `src/` Renderer Layer

### 2.1 Largest files — complexity hotspots

| Rank | LOC | File |
|-----:|----:|------|
| 1 | 1283 | `components/notes/note-editor.tsx` — editor + AI toolbar + CodeMirror wiring + autosave |
| 2 | 1033 | `components/notes/notes-view.tsx` — list/filter/folder tree/toolbar |
| 3 | 1019 | `components/flow/flow-view.tsx` — React Flow canvas + node/edge CRUD + dagre |
| 4 | 1009 | `components/agent/SessionPane.tsx` — 37 hook calls; streaming + spawn + diffs + terminal |
| 5 | 909 | `components/settings/AISettings.tsx` |
| 6 | 876 | `components/settings/AgentSettings.tsx` |
| 11 | 688 | `store/slices/terminal-sessions.ts` (god-slice; also holds domain types) |
| 12 | 684 | `components/agent/AgentChatPane.tsx` |
| 10 | 664 | `components/layout/project-overview.tsx` |
| 16 | 550 | `components/kanban/card-detail.tsx` (a modal in component clothing) |

### 2.2 Mixed file-naming convention

**77 PascalCase** vs **20 kebab-case** `.tsx` files in `src/components/`, mixed within the
same folder. Examples inside `components/layout/`: `title-bar.tsx`, `topbar.tsx`,
`sidebar.tsx` alongside `MigrationModal.tsx`, `RightPanel.tsx`, `QuickSettings.tsx`.

### 2.3 Half-finished file/folder refactor

Two directories have a `xxx.tsx` file sitting next to a `xxx/` subfolder holding its
sub-components — a decomposition that was started but never finished:

- **`components/chat/`** — `chat-panel.tsx` (480 lines) + `chat-panel/` subfolder containing
  `ChatMessageBubble`, `MarkdownContent`, `ToolCallIndicator`, `QuestionForm`,
  `SuggestedPrompts`, `ActionsList`, `message-ui`. The orchestrator imports from
  `./chat-panel/*` — the path looks like self-reference.
- **`components/layout/`** — `project-overview.tsx` (664 lines) + `project-overview/useProjectMetrics.ts`.

### 2.4 Hooks scattered across the tree

`src/hooks/` exists with only 2 files (`useChatStream.ts`, `useLoadGraph.ts`). Meanwhile
custom hooks live elsewhere:

- `components/layout/project-overview/useProjectMetrics.ts`
- `components/notes/notes-view/useNoteFilter.ts`
- `components/graph/analyticsHooks.ts` (`useContainerDims`, `useScopedData`, `useFontScale`)
- `lib/history.ts` (`useHistory`)
- `app/page.tsx` defines `useIpcErrorToasts` inline (lines 19–41; imports declared
  *after* the hook at line 42 — mid-file imports, mixing concerns)

No convention for where hooks go.

### 2.5 `types/index.ts` — 379-line barrel

All domain types in one file. Larger than several store slices. `PiAgentMessage` and
`PiSubagentMessage` (defined *inside* `store/slices/terminal-sessions.ts`, lines ~640-688)
violate this convention — they belong here.

### 2.6 Non-component `.ts` files mixed into `components/`

- `components/agent/TerminalManager.ts` — singleton, framework-agnostic; belongs in `lib/`
- `components/agent/editorTheme.ts` — CodeMirror theme shared by **both** notes and agent editors; lives inside `agent/` despite being generic
- `components/graph/analyticsUtils.ts`, `analyticsHooks.ts`, `graphUtils.ts`, `graph-ai-utils.ts` — 4 graph-helper modules (constants/hooks/colors/ai-context)

### 2.7 `lib/utils.ts` ⇄ `lib/constants.ts` re-export dance

`utils.ts` (68 lines) re-exports `PRIORITY_COLORS` from `./constants`; many files import
both. Two closely related modules with no clear boundary.

### 2.8 Wikilink parser duplicated across the ABI boundary

`src/lib/wikilink-parser.ts` (143 lines) has an inline copy in
`electron/db/graph-queries.ts` (per the source's own header comment). Two sources of
truth requiring manual sync.

---

## 3. Store Architecture

`src/store/index.ts` (381 lines) is the composition root. It defines `CairnStore` as an
intersection of 10 slices + a `HydrationSlice`. Slices follow a consistent
`StateCreator<CairnStore, [], [], Slice>` pattern.

| Slice | LOC | Notable |
|-------|----:|--------|
| `slices/ui.ts` | 268 | types `AIConfig`, `AgentConfig`, `Theme`, `FontScale`, `ToggleableView` |
| `slices/workspace.ts` | 193 | |
| `slices/board.ts` | 491 | 13 command-driven card/column actions |
| `slices/notes.ts` | 224 | |
| `slices/tags.ts` | 75 | |
| `slices/chat.ts` | 244 | |
| `slices/graph.ts` | 162 | `graphData` lazy-loaded by `loadGraph()` |
| `slices/selectors.ts` | 141 | pure derived getters |
| `slices/terminal-sessions.ts` | **688** | god-slice; also defines `PiAgentMessage`/`PiSubagentMessage` types |
| `slices/coding-agents.ts` | 90 | |

### 3.1 Hydration duplication (confirmed)

`hydrate()` (lines 155-220, ~65 lines) and `hydrateFromElectron()` (lines 222-361,
~140 lines) share **near-identical** restore blocks for: theme, fontScale, aiConfig,
agentConfig, hiddenViews, chatPanelWidth. Differences are isolated to where the value
comes from (`storage.get` vs `window.electron.getAiSettings`) and snapshot merging.
~50 lines of directly duplicated logic.

---

## 4. Analytics / Canvas Architecture

> **Doc bug**: AGENTS.md says "all seven analytics canvases" live in
> `src/components/insights/`. In reality only `InsightsView.tsx` lives there; the 7
> canvases + 2 KnowledgeGraph canvases + 4 shared modules all live in
> `src/components/graph/`.

### 4.1 The 7 canvases

| # | File | LOC | Render | Uses all 3 shared hooks? | Uses shared components? |
|---|------|----:|--------|:---:|---|
| 1 | `BulletCanvas.tsx` | 150 | pure SVG | ✓ | `CanvasEmptyState` |
| 2 | `SankeyCanvas.tsx` | 211 | SVG (`d3-sankey`) | ✓ | `CanvasEmptyState` only |
| 3 | `BeeswarmCanvas.tsx` | 174 | SVG (d3-force) | ✓ | All 3 — **reference impl** |
| 4 | `TimelineCanvas.tsx` | 259 | pure DOM | ✗ raw `useCairnStore` | none (inline empty state) |
| 5 | `TableCanvas.tsx` | 241 | pure DOM | ✗ raw `useCairnStore` | none (inline `<tr>` empty state) |
| 6 | `MatrixCanvas.tsx` | 333 | pure DOM (CSS container-query) | ✗ raw `useCairnStore` | none (inline + detail panel) |
| 7 | `RidgelineCanvas.tsx` | **398** | SVG (d3 line/area) | ✓ | `EmptyState` + `Tooltip` (but re-inlines `SvgTimeAxis`!) |

### 4.2 Shared scaffold (266 LOC total)

| File | LOC | Notable |
|------|----:|--------|
| `analyticsUtils.ts` | 52 | `PRIORITY_COLOR` (used by 3/7), `PRIORITY_WEIGHT` (**dead export**, never imported), `truncateName`, `CANVAS_PAD`, `HOUR_MS`/`DAY_MS` |
| `analyticsHooks.ts` | 72 | `useFontScale`, `useContainerDims` (4/7 SVG canvases), `useScopedData` (4/7 canvases) |
| `AnalyticsShared.tsx` | 130 | `<CanvasEmptyState>` (4/7), `<CanvasTooltip>` (declares an unused `containerH?` prop), `<SvgTimeAxis>` (declares an unused `plotH` prop; used only by Beeswarm) |
| `graphUtils.ts` | 12 | `resolveCssVar()` — only used by the 2 KnowledgeGraph canvas-2D contexts, not by any InsightsView canvas |

### 4.3 Duplications across canvases

| Duplicated concept | Where | Resolution |
|--------------------|-------|-----------|
| **Priority color map** | `analyticsUtils.PRIORITY_COLOR` (`low→text-tertiary`), `TimelineCanvas:16` (`low→success`), `TableCanvas:209` inline ternary (`low→success`) | 4 definitions; **inconsistent** — what should "low" look like? |
| **Priority sort weight** | Dead `PRIORITY_WEIGHT` export + `Sankey:82 po=` + `Timeline:15 PRIORITY_ORDER=` + `Table:24 PRIORITY_ORDER=` (3 of 4 are opposite direction of the shared one) | collapse all to one `sortByPriority` helper |
| **Empty state** | Re-inlined in Timeline (L72-79), Table (L230-236), Matrix (L92-98) | use `<CanvasEmptyState>` (extend with optional hint) |
| **Tick grid + "today" line** | `<SvgTimeAxis>` interior (AnalyticsShared L92-128) re-implemented nearly byte-for-byte in `RidgelineCanvas:297-318` | extend `SvgTimeAxis` props + consume in Ridgeline |
| **`lineColor = "var(--text-primary)"`** | Bullet:56, Sankey:88, Beeswarm:86, Ridgeline:279, inside `AnalyticsShared:76` itself | promote to a shared export |
| **`getBoundingClientRect()` pointer-pos math** | Beeswarm:129, Ridgeline:206, Ridgeline:227 | extract `useRelativePointer(ref)` hook |
| **`Date.now()` inside `useMemo` + `// eslint-disable react-hooks/purity`** | Bullet:33, Ridgeline:63, Ridgeline:196 | extract `useNow()` hook |
| **`PAD` object** | `CANVAS_PAD` shared; Beeswarm extends it (good); Ridgeline destructures it (ugly); Bullet/Sankey invent their own | commit to one story |
| **`PRIORITY_ORDER` + scope re-derivation** | Timeline/Table/Matrix each call `useCairnStore(useShallow(...))` rather than `useScopedData` | extend `useScopedData` to cover notes/tags |

### 4.4 Key stylings

`<CanvasTooltip>` and `<SvgTimeAxis>` both declare unused props (`containerH?`,
`plotH`). Likely half-finished refactors.

### 4.5 BeeswarmCanvas is the reference implementation

It is the only canvas that uses the entire shared scaffold (`EmptyState` + `Tooltip` +
`TimeAxis` + all 3 hooks + `CANVAS_PAD` via spread + `PRIORITY_COLOR` shared + `truncateName`).
Use it as the "how it should look" template when fixing the others.

---

## 5. Electron + IPC + MCP Layer

### 5.1 `electron/main.ts` (317 LOC) — clean orchestrator

9 startup responsibilities, each delegated to a sibling module. No god-object tendency.
Minor smell: 27-line `getStoredThemeBackground()` + `getStoredThemeSurface()` duplicating
the same `theme.json` read.

### 5.2 `electron/preload.ts` (532 LOC) — 100+ method IPC surface in one file

Single `api` object literal exposed via `contextBridge.exposeInMainWorld`. Namespaces:
`workspace`, `project`, `note`, `column`, `card`, `flow`, `tag`, `chat`, `graph`, `ai`,
`agent` (42 methods, 144 LOC alone for `piAgent`), `llama`, `mobile`, `updater`,
`migrations`. **30+ repeated `// eslint-disable @typescript-eslint/no-explicit-any`
boilerplate** for event callbacks.

Structurally fine for a preload, but at 532 lines is a split candidate.

### 5.3 `electron/ipc/` — 6 files, one is a god-file

| File | LOC | Channels |
|------|----:|---------|
| `registry.ts` | 88 | clean — `registerIpcHandle`/`registerIpcOn`/`broadcastEvent`, `isWriteChannel` whitelist |
| `handlers.ts` | **1054** | 60+ `db:*`, `app:*`, `llama:*`, `mobile:*`, `ai:*`, `mcp:*`, `updater:*` |
| `agent.ts` | 564 | `agent:*` (coding-agent pty/bash/file ops) |
| `pi-agent.ts` | 501 | `pi-agent:*` (cairn-native agent) |
| `chat.ts` | 384 | `chat:stream`, `chat:abort`, `chat:compactThread` |
| `chat-executor.ts` | 262 | single-tool-call executor invoked by chat.ts |

#### `handlers.ts` smells (1054 LOC)

1. **`db:flow:node:summarize`** (lines 406-542, ~140 LOC) — inlined BFS traversal + LLM
   call. Same BFS is partly duplicated by `getResolvedFlow` in `queries.ts:651-735`.
2. **`db:flow:url:fetch`** (lines 960-1009, ~50 LOC) — inlined OG-tag HTML scraper.
   Belongs in `lib/url-metadata.ts`.
3. **`app:exportNotePdf`** (lines 849-958, ~110 LOC) — inlined ~60-line HTML/CSS PDF
   template string. Belongs in `lib/pdf-template.html` or similar.
4. **`llama:*` handlers** (lines 577-630) — `require()` calls wrapped in eslint-disable
   comments. Valid lazy requires, but the disable is a smell.
5. **`getProjectName`** (lines 65-68) — re-implementation of `q.getProjectById`. Use the
   query helper.
6. **`db:chat:clearThreadMessages`** (line 555) — inlined `DELETE FROM chat_messages`
   instead of delegating to a `q.*` helper (every other chat handler does).

### 5.4 SQL access layer — `electron/db/queries.ts` (1244 LOC) + `graph-queries.ts` (707 LOC)

`queries.ts` is one well-organized god-module: 132 `db.prepare()` calls across
workspaces/projects/notes/columns/cards/tags/chat/mcp-notifications/idea-flow/snapshot/
search/coding-agents/pi-sessions/llm-history/codebase-indexing. Snake_case columns →
camelCase fields on read (convention noted in header comment).

`graph-queries.ts` adds 19 more `db.prepare()` calls for knowledge-graph traversal +
relationship-cache invalidation. Includes its own `WIKILINK_RE` (duplicated from
`src/lib/wikilink-parser.ts`).

`electron/shared/` is genuinely well-factored: `db-mappers.ts`, `notes-io.ts`,
`read-tools-pure.ts`, `text-utils.ts` — already shared between main process and MCP
bundle. **This proves the cross-bundle import works.**

### 5.5 The ABI boundary that isn't (the big one)

AGENTS.md states: *"mcp-server.ts uses inlined SQL only (no queries.ts import) due to
Node ABI boundary"*.

**This is stale.** Counterevidence:

- `electron/mcp/tools/codebase.ts:2` already imports `* as q from "../../db/queries"` —
  and it works in the bundled MCP binary.
- The `electron/shared/` modules are imported in the MCP bundle (see §5.4).
- The only ABI-sensitive operation in `better-sqlite3` is constructing the `Database`
  instance — that happens once in `mcp-server.ts:140` via `new Database(dbPath,
  { nativeBinding: MCP_NATIVE_BINDING })`. After that, `db.prepare(...).run(...)` works
  on that handle regardless of which TS file defines it.

**Result:** ~1000 lines of duplicated SQL across 6 MCP tool files
(`notes.ts`, `tasks.ts`, `projects.ts`, `tags.ts`, `flow.ts`, `dashboards.ts`) and
`mcp/tools/graph.ts` (~80% of the queries.ts surface area is duplicated verbatim — same
INSERT/UPDATE/DELETE algorithm, same BFS in `get_idea_flow` vs `getResolvedFlow`).

| Pair (queries.ts ↔ mcp/tools) | Duplicated |
|-------------------------------|-----------|
| 22+ INSERT/UPDATE/DELETE helpers (note/card/project/tag/flow/dashboard) | yes — see `§5.6` |
| `q.getResolvedFlow` (84 LOC) | `get_idea_flow` (100 LOC) — near-identical algorithm |
| `q.getKnowledgeGraph` + `getNeighbours` (+ BFS + auto-relationship_cache, 707 LOC file) | `mcp/tools/graph.ts:get_knowledge_graph` + `get_neighbors` — same algorithm reconstructed, 183 LOC |
| `q.getFullSnapshot` | `mcp/db.ts:getSnapshot` (returns a *partial* shape; divergent `tags` mapping) |

### 5.6 Native folders

```
electron-native/better_sqlite3_electron.node  1.93 MB  live (Electron ABI; used by db/client.ts)
mcp-native/better_sqlite3_node.node           1.93 MB  DEAD (removed in v0.3.8, folder left behind)
pkg-native/better_sqlite3.node                1.93 MB  live (pkg binary + rebuilt for vitest env var)
pkg-native/better_sqlite3_node25.node         1.93 MB  likely orphaned (no references found)
vitest-native/better_sqlite3.node             1.93 MB  system-Node ABI (kept; pkg-native is Node 22 ABI)

**Not redundant despite looking alike:** `pkg-native/` holds the Node 22 ABI build (for
the pkg-bundled MCP binary); `vitest-native/` holds the system-Node ABI build (for
vitest under whatever Node the developer runs). These only coincide on Node 22.
CONTRIBUTING.md:55 documents three distinct ABIs (Electron, Node 22/MCP, system Node).

`vitest.config.ts:14-19` set `BETTER_SQLITE3_BINDING` env var pointing to `pkg-native/`
with a comment claiming "pkg-native/ always has the system Node ABI" (false — it's the
Node 22 build). `vitest-sqlite-shim.cjs:13` hardcoded `vitest-native/` and ignored the
env var. **Fix (P0-2): make the shim honor the env var AND point vitest.config.ts at
`vitest-native/`** (the actually-correct ABI). Keep both folders.

### 5.7 tsconfig split — two configs is enough

| Config | Includes | Coverage |
|--------|----------|----------|
| `tsconfig.json` | `**/*` excluding `scripts`, `electron` | renderer + `src/` — used by `tsc --noEmit` and CI |
| `tsconfig.electron.json` | `electron/**/*.ts` | electron main + ipc + db + mcp + lib |
| `tsconfig.mcp.json` | only `electron/mcp-server.ts` | single root file → TypeScript **won't pull transitive imports**; superficial coverage |

**CI gap:** `.github/workflows/ci.yml:38` runs only `npx tsc --noEmit`. The
electron/mcp codebases are **never type-checked in CI**. Type errors in `electron/` only
surface (if at all) when `npm run compile` bundles via esbuild — which doesn't typecheck
either. This directly contradicts the AGENTS.md instruction to "always run
`tsc --noEmit` after changes".

The `@shared/*` path alias in `tsconfig.electron.json:14-16` is unused.
`grep -rn '@/shared\|@shared/' electron/` returns no matches.

---

## 6. Cross-Cutting: Modal & MessageBubble Duplication

### 6.1 Eight modal components, no shared base

```
components/layout/MigrationModal.tsx         195
components/agent/SpawnAgentModal.tsx          334
components/flow/NodeEditModal.tsx              408
components/notes/DashboardApiModal.tsx        123
components/notes/DashboardTemplateModal.tsx    300
components/notes/notes-view/MoveNoteModal.tsx  ~80
components/notes/notes-view/PrdModal.tsx      318
components/kanban/card-detail.tsx             550   ← modal in clothing
```

There is a generic `ui/dialog.tsx` (Radix Dialog wrapper). **None of these modals build on
it consistently.** A `<ModalShell>` extraction would unify ~200 LOC of repeated dialog
chrome (close button, header/title, footer, escape handling, portal).

### 6.2 Two parallel "message bubble" implementations

```
components/agent/AgentMessageBubble.tsx        395 LOC
components/chat/chat-panel/ChatMessageBubble.tsx 180 LOC
```

Verified that both have **byte-identical** `CAIRN_NOTE_ACTIONS` and `CAIRN_TASK_ACTIONS`
lookup tables at the top. Both render markdown via `MarkdownContent`, both use
`MessageAvatar`/`StreamingCursor` from the shared `message-ui.tsx`, both emit
`CairnEvents`. They differ only in message type (`PiAgentMessage` vs `ChatMessage`) and
subagent rendering. Strong `<MessageBubble>` extraction candidate.

### 6.3 CodeMirror editor wrappers scattered

```
agent/FileEditorInner.tsx   221 LOC  (CodeMirror 6 view wrapper, plain files)
notes/markdown-editor.tsx   305 LOC  (CodeMirror 6 view wrapper, markdown)
notes/note-editor.tsx      1283 LOC  (composes MarkdownEditor + AI toolbar)
agent/editorTheme.ts                 shared CodeMirror theme — lives IN agent/, used by both
```

`editorTheme.ts` should be in `lib/`. The two CM6 wrappers could share a base.

### 6.4 Three markdown rendering entries

```
components/notes/NoteMarkdownPreview.tsx       (notes preview)
components/chat/chat-panel/MarkdownContent.tsx  (218 LOC, chat's own renderer)
lib/markdown/pipeline.tsx                       (248 LOC, exported pipeline + an `InlineCode` React component — module types mixed)
```

Both previews consume `lib/markdown/pipeline.tsx`'s remark plugins but neither shares a
renderer component.

---

## 7. Test Layout — Scattered, Some Dead

19 test files in 3 conventions + e2e:

```
electron/db/queries.test.ts
electron/ipc/agent.test.ts
electron/ipc/chat-executor.test.ts
electron/ipc/handlers.test.ts
electron/ipc/tool-parity.test.ts            ← likely dead (refer to removed TOOL_DEFINITIONS)
electron/lib/codebase-index.test.ts
electron/lib/context-audit.test.ts
electron/lib/grep-vs-semantic.test.ts
electron/lib/llama-server.test.ts
electron/lib/local-llm-real.test.ts
electron/lib/local-llm.test.ts
electron/lib/pi-agent-loop.test.ts
electron/mcp-server.test.ts
electron/migrations.test.ts
electron/notes-files.test.ts
electron/obsidian-compat.test.ts
src/components/graph/GraphAIPanel.test.ts    ← orphaned (no GraphAIPanel.tsx exists)
src/components/notes/markdown-pipeline.bench.test.ts
src/lib/wikilink-parser.test.ts
tests/e2e/smoke.test.ts
```

No `__tests__/` directory; no consistent co-location rule.

### 7.1 Dead test/code

- `src/components/graph/GraphAIPanel.test.ts` — **correction**: this test is *not*
  orphaned; it imports and tests `./graph-ai-utils` (which exists and exports
  `wikilinkAlreadyExists` + `buildGraphContext`, 16 passing tests). Only the *filename*
  is misleading. Rename to `graph-ai-utils.test.ts` — done in P0-1.
- `scripts/check-tool-parity.ts` (87 LOC) greps for `const TOOL_DEFINITIONS` which was
  refactored away into `electron/lib/tool-schemas.ts`. Not run by CI. Companion
  `electron/ipc/tool-parity.test.ts` is similarly stale.

---

## 8. Risk Summary

The findings above fall into four risk categories:

1. **Correctness risk** (fix soonest):
   - CI never type-checks `electron/` (silent type-error surface, growing)
   - Orphaned/dead tests give false confidence (CI is green but not testing what it claims)
   - 4 inconsistent definitions of `PRIORITY_COLOR` — visual inconsistency *and* a bug
     magnet if a fifth definition is added
   - Stale AGENTS.md ABI-boundary claim steers new code toward more SQL duplication

2. **Maintenance cost** (highest LOC drag):
   - ~1000 lines of duplicated SQL across the Electron↔MCP boundary
   - 1054-line `handlers.ts` mixing 7 domains
   - 6 god-components over 800 LOC
   - Store hydration duplication

3. **Cognitive complexity** (smoothness of onboarding / further work):
   - 4 graph-helper modules, 8 modals with no shared base
   - Half-finished folder refactor (`chat-panel.tsx` vs `chat-panel/`)
   - Mixed kebab/Pascal case
   - Hooks scattered across the tree

4. **Hygiene** (cheap to fix, removes dead weight):
   - Dead `mcp-native/` folder, possibly dead `_node25.node`
   - Misleading `BETTER_SQLITE3_BINDING` env var in `vitest.config.ts` (pointed at `pkg-native/` but the shim ignored it)
   - Stale `tsconfig.mcp.json`
   - Unused `@shared/*` path alias
   - Unused props in shared canvas components
   - Dead `PRIORITY_WEIGHT` export

The `implementation-plan.md` in this folder sequences the remediation work to start with
the cheap hygiene wins, then the SQL consolidation (single biggest LOC saving), then the
structural refactors.
