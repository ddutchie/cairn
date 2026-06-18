# Cairn — Cleanup Implementation Plan

> Companion to `findings.md`. Read that first; this document assumes its analysis.
>
> **Guiding principles:**
> 1. **Defer behaviour changes.** Every phase must be a no-op refactor that preserves
>    observable behaviour — verified by the existing test suite + manual smoke. New
>    features are explicitly out of scope.
> 2. **Small, reviewable PRs.** Each numbered item below should be its own PR (or a
>    short series). Target ≤400 LOC of diff per PR.
> 3. **Verify at every step.** After each item, run `npm run type-check`,
>    `npm test`, `npm run lint -- --max-warnings 0`, and (for electron changes)
>    `npm run compile`. Once item P0-3 lands, "type-check" covers electron too.
> 4. **Update docs as we go.** AGENTS.md and changelogs/ must reflect each change
>    that affects the agent contract or developer workflow.

Each item is tagged with **phase**, **risk**, **estimated effort**, and the
**finding(s)** from `findings.md` it addresses.

---

## P0 — Hygiene & Safety Net  (do first; cheap, lowers risk for everything else)

These are local, mostly mechanical changes that prevent later work from introducing
silent regressions. **No architecture changes.**

### P0-1 — Delete dead files & folders
**Risk:** minimal · **Effort:** 30 min · **Findings:** §5.6, §7.1

- `rm -rf mcp-native/` (removed in v0.3.8 per `changelogs/v0.3.8.md`)
- Delete `scripts/check-tool-parity.ts` and `electron/ipc/tool-parity.test.ts` — both
  reference the removed `TOOL_DEFINITIONS` constant.
- Delete `src/components/graph/GraphAIPanel.test.ts` (orphaned; no matching component).
  First run `npm test` to confirm it is not silently excluded; if it is being skipped,
  capture the skip reason in `changelogs/`.
- Investigate `pkg-native/better_sqlite3_node25.node`: `grep -rn '_node25' .` — if no
  in-repo references, delete with a note in `changelogs/`.

**Verify:** `npm test` still passes; `npm run compile` still produces bundles.

### P0-2 — Reconcile native binding setup
**Risk:** low · **Effort:** 1 h · **Findings:** §5.6

**Correction (post-investigation):** `vitest-native/` is NOT redundant with
`pkg-native/`. They hold *different* ABIs in general — `pkg-native/` is the Node 22
build (for the pkg-bundled MCP binary), `vitest-native/` is the system-Node build (for
vitest). They only coincide when the developer is on Node 22. With no `engines` / `.nvmrc`
pin in the repo, consolidating would silently break vitest on Node ≠ 22.

**Actual fix (Option B):** make the existing env var meaningful instead of eliminating
the folder.
- `vitest-sqlite-shim.cjs` now reads `process.env.BETTER_SQLITE3_BINDING` (falling back
  to `vitest-native/better_sqlite3.node`). Previously the shim hardcoded the path and
  overrode the env var.
- `vitest.config.ts` env var repointed at `vitest-native/` (the correct system-Node
  ABI), not `pkg-native/`. Misleading comment fixed.
- Documentation (`CONTRIBUTING.md`, `README.md`) already correctly describes three
  distinct ABIs; no doc change needed beyond the changelog.

**Verify:** `npm install && npm run rebuild && npm test` works on a fresh clone.

### P0-3 — Fix CI type-check coverage & tsconfig
**Risk:** low · **Effort:** 1 h · **Findings:** §5.7

- Delete `tsconfig.mcp.json` (single-file config gives superficial coverage).
- Remove the unused `@shared/*` path alias from `tsconfig.electron.json:14-16`.
- Add to `package.json`:
  ```json
  "type-check": "tsc --noEmit",
  "type-check:electron": "tsc --noEmit -p tsconfig.electron.json",
  "type-check:all": "npm run type-check && npm run type-check:electron"
  ```
- Update `.github/workflows/ci.yml` `type-check` job to run `npm run type-check:all`.
  Expect **red CI on first run** — fix the surfaced errors before merging.
- Update `AGENTS.md`: replace "always run `npx tsc --noEmit` after changes" with
  "`npm run type-check:all`".

**Verify:** CI `type-check` job now exercises electron code; any pre-existing electron
type errors surface and are fixed.

### P0-4 — Sync stale esbuild target
**Risk:** minimal · **Effort:** 10 min · **Findings:** §5.7

`package.json` `compile` script builds `mcp-server.ts` with `--target=node20`, but
`scripts/build.js:60` builds it with `--target=node22` and `scripts/rebuild-native.js`
rebuilds better-sqlite3 for Node 22. Align `package.json:compile` to `--target=node22`.

**Verify:** `npm run compile && npm run mcp` succeeds.

### P0-5 — Fix stale AGENTS.md ABI-boundary claim
**Risk:** none (docs only) · **Effort:** 10 min · **Findings:** §5.5

Rewrite the AGENTS.md "Key constraints" section:
- Replace *"mcp-server.ts uses inlined SQL only (no `queries.ts` import) due to Node
  ABI boundary"* with: *"The only ABI-sensitive operation in `better-sqlite3` is
  constructing the `Database` instance; that happens once in `mcp-server.ts:140` via
  `new Database(dbPath, { nativeBinding: MCP_NATIVE_BINDING })`. Helper functions in
  `db/queries.ts` and `db/graph-queries.ts` may be imported from `electron/mcp/tools/*`
  just as `mcp/tools/codebase.ts` already imports `* as q from '../../db/queries'`. Never
  construct a `Database` instance outside `mcp-server.ts` / `mcp/db.ts`."*
- Also fix the doc bug noted in §4: "all seven analytics canvases live in
  `src/components/insights/`" — they live in `src/components/graph/`; only
  `InsightsView.tsx` is in `insights/`.

**Verify:** n/a.

---

## P1 — SQL Consolidation  (biggest LOC saving; do second)

The ABI-boundary constraint turned out to be fictional (see `findings.md §5.5`).
Consolidating MCP-side SQL onto the existing `db/queries.ts` + `db/graph-queries.ts`
helpers removes ~1000 LOC of duplication and gives the MCP server the same query
behaviour as the Electron main process (currently a known divergence source).

**Approach:** migrate one MCP tool file at a time. Each migration is independently
shippable. Run `npm test` (which includes `electron/mcp-server.test.ts`) and a manual
MCP smoke (`npm run smoke-test` or invoking tools via opencode) after each.

### P1-1 — `mcp/tools/tags.ts`
**Risk:** low · **Effort:** 30 min · **Findings:** §5.5
Replace the single `db.prepare(...)` INSERT with `q.createTag(db, ...)`. The
`resolveTagNames` helper (in `mcp/db.ts`) is currently MCP-only; keep it where it is for
now — it's not duplicated in queries.ts but could be offered as `q.resolveTagNames`
later if main process needs it.

### P1-2 — `mcp/tools/projects.ts`
**Risk:** low · **Effort:** 1 h · **Findings:** §5.5
Replace the `upsert_project` (insert/update branches + inline column creation) and
`delete_project` (the 4-DELETE sequence) with `q.createProject`, `q.updateProject`,
`q.deleteProject`. The 9 `db.prepare` calls in this file all collapse.

### P1-3 — `mcp/tools/dashboards.ts`
**Risk:** low · **Effort:** 30 min · **Findings:** §5.5
Both `create_dashboard` and `update_dashboard` are note writes with `type='dashboard'`.
Use `q.createNote` and `q.updateNote` (which already handle the `type` field).

### P1-4 — `mcp/tools/notes.ts`
**Risk:** medium (optimistic-write semantics matter) · **Effort:** 2 h · **Findings:** §5.5
`ensure_note`, `append_to_note`, `patch_note`, `delete_note` map to `q.createNote`,
`q.updateNote`, `q.deleteNote`. **Caveat:** `mcp/db.ts` has its own note-version +
lock/unlock table (`getNoteVersion`, `lockNote`, `unlockNote`) used by the
`ensureNote`/`patchNote` flows to implement optimistic writes. Move that logic into
`db/queries.ts` as `q.lockNote`/`q.unlockNote`/`q.getNoteVersion` so both surfaces share
the implementation; keep the MCP entrypoints calling them.

### P1-5 — `mcp/tools/tasks.ts`
**Risk:** medium (large file, 28 prepare calls) · **Effort:** 4 h · **Findings:** §5.5
Map each tool onto the corresponding `q.*` helper. The two copies of
`clearBlockersFromAll` (one in `bulk_update_task_status`, one in `update_task`) collapse
to one `q.clearBlockersFromAll(db, cardId)`. `list_ready_tasks` becomes `q.getReadyCards`
(verify shape: the MCP tool returns a slightly different shape — wrap in a thin mapper).

### P1-6 — `mcp/tools/flow.ts`
**Risk:** medium · **Effort:** 4 h · **Findings:** §5.5
The big one: `get_idea_flow` (~100 LOC) duplicates `q.getResolvedFlow` (84 LOC) almost
verbatim. Collapse. The remaining create/update/delete node + create/delete edge
operations map 1:1 to `q.*` helpers. The `layout_idea_flow` tool's dagre call can stay
(equivalent already exists in the electron-side `flow-layout.ts`; consider exposing it
as `q.layoutFlow` later).

### P1-7 — `mcp/tools/graph.ts`
**Risk:** medium-high · **Effort:** 6 h · **Findings:** §5.5
`get_knowledge_graph` (114 LOC, 12 prepare calls) and `get_neighbors` reconstruct the
algorithm in `db/graph-queries.ts` (`getKnowledgeGraph` is 312 LOC in a 707-LOC file;
`getNeighbours`). Consolidate by importing from `db/graph-queries.ts`. **Caveat:** the
filter shapes differ (`graphFilters` on electron side vs flat `includeAuto`/`nodeTypes`/
`edgeTypes`/`projectIds` on MCP side) — write a small mapper; do not change the public
MCP API or the public `loadGraph` store action signatures.

### P1-8 — `mcp/db.ts` snapshot reconciliation
**Risk:** low · **Effort:** 1 h · **Findings:** §5.5
Replace `mcp/db.ts:123-137 getSnapshot` with `q.getFullSnapshot`. **Fix the divergence at
the same time:** the current `getSnapshot` returns a 4-field `tags` shape; the Electron
`getFullSnapshot` returns the full `toTag(...)` shape. Update MCP callers that relied on
the partial shape to read the full shape (verify `mcp/tools/index.ts` doesn't destructure
narrow fields).

### P1-9 — Update `electron/db/queries.ts` governance
**Risk:** none · **Effort:** 30 min · **Findings:** §5.5
Add a header comment to `queries.ts` explicitly stating: *"single source of truth for
all SQL. Imported by both the Electron main process and the esbuild-bundled MCP
server (see `electron/mcp/tools/codebase.ts` for precedent). Never construct a
`Database` here — `new Database()` lives in `db/client.ts` (Electron) and
`mcp/db.ts:MCP_NATIVE_BINDING` (MCP runtime)."*

**Gate for P2:** after P1 is merged, run a manual MCP smoke test against opencode
(invoking every tool) to confirm no regression. Then proceed.

---

## P2 — IPC `handlers.ts` Decomposition  (do third)

`electron/ipc/handlers.ts` (1054 LOC) mixes 7 unrelated domains. Split it the same way
`ipc/agent.ts` and `ipc/pi-agent.ts` already work — one register function per file.
Keep `ipc/registry.ts` as the single source of truth for `isWriteChannel`.

### P2-1 — Extract `ipc/pdf-export.ts`
**Risk:** low · **Effort:** 1 h · **Findings:** §5.3
Move `app:exportNotePdf` (lines 849-958). Move the ~60-line HTML/CSS template to
`electron/lib/pdf-template.html` (load with `fs.readFileSync` at module init). Net
handler file size drops by ~110 LOC.

### P2-2 — Extract `ipc/url-metadata.ts`
**Risk:** low · **Effort:** 1 h · **Findings:** §5.3
Move `db:flow:url:fetch` (lines 960-1009). The OG-tag scraper belongs in
`lib/url-metadata.ts`; the handler calls into it. ~50 LOC out of handlers.ts.

### P2-3 — Extract `ipc/flow-handlers.ts` (incl. inlined BFS)
**Risk:** medium (BFS logic) · **Effort:** 2 h · **Findings:** §5.3
Move idea-flow IPC channels (lines 406-542 for `db:flow:node:summarize` and surrounding
CRUD). **Important:** the inlined BFS in `db:flow:node:summarize` is partly duplicated
by `q.getResolvedFlow` (queries.ts:651-735). Move the BFS into a
`q.summarizeFlowNode`-style query helper if a real shared algorithm can be extracted;
otherwise move the inlined block into `electron/lib/flow-summarize.ts` and surface a
single clean entrypoint.

### P2-4 — Split handlers.ts by domain
**Risk:** low · **Effort:** 2 h · **Findings:** §5.3
The remaining ~700 lines, split per the existing channel prefixes:
- `ipc/db-handlers.ts` — workspace/project/note/column/card/tag/chat/sessions CRUD
- `ipc/llama-handlers.ts` — lines 579-629
- `ipc/mobile-handlers.ts` — lines 823-846
- `ipc/migration-handlers.ts` — lines 1011-1032
- `ipc/settings-handlers.ts` — lines 729-750, 1033-1052 (theme/font/workspace settings)
- `ipc/app-handlers.ts` — workspace folder picker, relaunch, reset, updater install,
  the remainder
- `handlers.ts` becomes a thin `registerIpcHandlers(ctx)` that calls each module in turn.

Then delete the small `getProjectName` helper (use `q.getProjectById`) and the inlined
`db:chat:clearThreadMessages` SQL (add `q.clearChatThreadMessages`).

**Verify:** `electron/ipc/handlers.test.ts` still passes unchanged.

---

## P3 — Component Extractions  (do fourth)

Pieces of P3 are independent of each other and can be parallelised across PRs.

### P3-1 — Extract `<ModalShell>` and migrate modals
**Risk:** low · **Effort:** 1.5 days · **Findings:** §6.1
Build `<ModalShell>` on top of `ui/dialog.tsx` (props: `title`, `description`,
`children`, `footer?`, `size?`, `onClose`). Migrate the 8 modal components one at a time.
Order by simplicity: `DashboardApiModal` → `MoveNoteModal` → `MigrationModal` →
`PrdModal` → `DashboardTemplateModal` → `SpawnAgentModal` → `NodeEditModal` →
`card-detail.tsx` (largest). Each migration is its own PR.

### P3-2 — Extract shared message bubble
**Risk:** medium (touches agent + chat) · **Effort:** 1 day · **Findings:** §6.2
Extract `<MessageBubble>` that takes a `Message`-strategy prop. Move the
`CAIRN_NOTE_ACTIONS` / `CAIRN_TASK_ACTIONS` tables to a shared module (e.g.
`src/lib/note-task-actions.ts`) so there is exactly one source of truth. Migrate
`ChatMessageBubble` first (simpler), then `AgentMessageBubble` (with its subagent branch).

### P3-3 — Promote `editorTheme.ts` and unify CM6 wrappers
**Risk:** low · **Effort:** 1 day · **Findings:** §6.3
- Move `components/agent/editorTheme.ts` → `lib/editor-theme.ts` (it's a shared
  CodeMirror theme for both the notes and agent editors).
- Consider a shared `<CodeMirrorView>` base for `agent/FileEditorInner.tsx` and
  `notes/markdown-editor.tsx`. Start by extracting their common ResizeObserver +
  imperative-handle pattern; keep extension sets per-use-case.

### P3-4 — Finish the `chat-panel/` + `project-overview/` refactor
**Risk:** low · **Effort:** 2 h · **Findings:** §2.3
- Convert `components/chat/chat-panel.tsx` (480 LOC) into
  `components/chat/chat-panel/index.tsx`. Move the sibling subfolder's files into the
  same index. Update imports throughout.
- Same for `components/layout/project-overview.tsx` (664 LOC) → `project-overview/index.tsx`;

then `useProjectMetrics.ts` lives next to its index.

### P3-5 — Consolidate graph helpers
**Risk:** low · **Effort:** 3 h · **Findings:** §2.6, §4.2
The `components/graph/` folder has 4 helper modules with overlapping concerns:
- `analyticsUtils.ts` (constants + helpers)
- `analyticsHooks.ts` (3 hooks)
- `graphUtils.ts` (1 function, `resolveCssVar`)
- `graph-ai-utils.ts` (chat-context builder)

Move `graphUtils.ts`'s `resolveCssVar` into `analyticsUtils.ts` (or a new
`graph-colors.ts` if we prefer to keep pure utils separate from canvas constants).
Delete `graphUtils.ts`. Leave `graph-ai-utils.ts` alone for now — it's a different
concept (AI context, not analytics rendering).

### P3-6 — Centralise hooks in `src/hooks/`
**Risk:** low · **Effort:** 2 h · **Findings:** §2.4
Move:
- `components/layout/project-overview/useProjectMetrics.ts` → `hooks/useProjectMetrics.ts`
- `components/notes/notes-view/useNoteFilter.ts` → `hooks/useNoteFilter.ts`
- `components/graph/analyticsHooks.ts` → `hooks/analytics.ts` (keep the same exports)
- `lib/history.ts`'s `useHistory` function can stay (co-located with the history
  singleton) OR move if it grows

Then extract `useIpcErrorToasts` out of `app/page.tsx:19-41` into
`hooks/useIpcErrorToasts.ts` and move the imports to the top of the file.

---

## P4 — Analytics Canvas Consistency  (do fifth)

These are the "shared scaffold that half the canvases ignore" fixes from §4. The goal
is to make Beeswarm's "full adherence" the rule, not the exception. Each item is local
to one canvas file and shippable independently.

### P4-1 — Unify priority colors + sort weights
**Risk:** low · **Effort:** 1 h · **Findings:** §4.3
- Delete the dead `PRIORITY_WEIGHT` export from `analyticsUtils.ts` **or** repurpose it
  into a `sortByPriority(arr, dir)` helper.
- Decide the canonical "low" priority color. Recommendation: **`var(--text-tertiary)`**
  (matches the shared `PRIORITY_COLOR` and treats "low" as "muted"). If product wants
  "low" to be a success-ish green, change `PRIORITY_COLOR` in the shared module and
  update the 3 SVG canvases that consume it.
- Replace `TimelineCanvas.tsx:16-21` local `PRIORITY_COLOR` and `TableCanvas.tsx:209`
  inline ternary with imports of the shared `PRIORITY_COLOR`.
- Replace the 3 local `PRIORITY_ORDER`/`po` definitions (Sankey L82, Timeline L15,
  Table L24) with the shared helper.

### P4-2 — Remove dead props in shared components
**Risk:** none · **Effort:** 15 min · **Findings:** §4.4
- Drop the unused `containerH?` prop from `<CanvasTooltip>` (`AnalyticsShared.tsx:31`).
- Drop the unused `plotH` prop from `<SvgTimeAxis>` (`AnalyticsShared.tsx:57`, 68).

### P4-3 — Extract `useRelativePointer(ref)` and `useNow()` hooks
**Risk:** low · **Effort:** 1 h · **Findings:** §4.3
- `useRelativePointer(ref)` returns `(e) => { x, y }` (calls
  `getBoundingClientRect`). Replaces 3 occurrences: Beeswarm:129, Ridgeline:206, 227.
- `useNow()` returns `Date.now()` updated on mount (and optionally on a slow interval
  of e.g. 60s for canvases that should reflect "today" over long sessions). Replaces
  BulletCanvas:33 and RidgelineCanvas:63, 196 and removes the
  `// eslint-disable react-hooks/purity` comments.

Move both into `src/hooks/` (after P3-6 lands) or `components/graph/analyticsHooks.ts`.

### P4-4 — Use `<SvgTimeAxis>` in Ridgeline
**Risk:** low · **Effort:** 1 h · **Findings:** §4.3
Replace the inline tick grid + "today" line in `RidgelineCanvas.tsx:297-318` with
`<SvgTimeAxis>`. May require extending `SvgTimeAxis` props (e.g. `tickValues?` or
`xScale?`) — keep changes additive.

### P4-5 — Unify empty states
**Risk:** low · **Effort:** 1 h · **Findings:** §4.3
Extend `<CanvasEmptyState>` to accept an optional `hint?` prop (secondary line) to
support Timeline's two-paragraph style. Migrate Timeline, Table, Matrix to use it.

### P4-6 — Promote `useScopedData` for DOM canvases
**Risk:** medium · **Effort:** 3 h · **Findings:** §4.3
Timeline / Table / Matrix each re-derive `scopedCardIds`/`scopedEntityIds` after
`useShallow` reads. Extend `useScopedData` (or add `useScopedEntities`) to return
`notes` and `tags` (currently returns `projects`, `cards`, `columns`). Migrate the
3 canvases to it.

### P4-7 — Document the PAD story
**Risk:** none · **Effort:** 30 min · **Findings:** §4.3
Pick one of:
- **(A)** Honor `CANVAS_PAD` everywhere; align Bullet (left:200, right:48) and Sankey
  (left:160, right:120) to the shared standard.
- **(B)** Accept per-canvas `PAD` objects and remove `CANVAS_PAD` from the shared utils.

Recommendation: **(B)**. Per-canvas padding is intentional (the canvases genuinely need
different margins) and the shared value falsely implies a standard. Remove
`CANVAS_PAD` from `analyticsUtils.ts` and update Beeswarm to define its own.

### P4-8 — Extract `<MatrixDetailPanel>`
**Risk:** low · **Effort:** 2 h · **Findings:** §4.7 of explore report
The MatrixCanvas detail panel (lines 268-330) and the Sankey side panel (lines 165-208)
have the same "pinned/hovered entity → side detail" shape. Extract a generic
`<CanvasSidePanel>` and adopt in both. (Optional — only do if P3-1 `<ModalShell>`
validates that the extraction pattern works cleanly here.)

---

## P5 — God-Component Splits  (do last; biggest commitment)

This is the highest-risk phase. Each split must be independently shippable and verified
by manual smoke (load a workspace, create/read/update/delete the entity, check undo,
check electron refresh).

Order suggested from lowest to highest risk. Each is its own multi-PR sequence.

### P5-1 — Split `terminal-sessions.ts` slice + relocate types
**Risk:** medium · **Effort:** 1 day · **Findings:** §1 TL;DR #5, §2.5, §3
- Move `PiAgentMessage`, `PiSubagentMessage` and the inline subagent/toolcall types
  to `src/types/index.ts` (where every other domain type lives).
- Within `terminal-sessions.ts` (688 LOC) consider extracting a sub-slice for sessions
  vs messages if seams emerge after the type move.

### P5-2 — Split `app/page.tsx` (410 LOC)
**Risk:** low · **Effort:** 4 h · **Findings:** §2.4, §1 TL;DR
- Extract `useIpcErrorToasts` (covered by P3-6).
- Move view imports above the inline hook (mid-file import is a code smell).
- Consider a `<ViewRouter activeView={...}>` component that owns the switch statement
  (lines 295-318 of InsightsView is the existing pattern; same applies to the page.tsx
  view switch).

### P5-3 — Split `kanban/card-detail.tsx` (550 LOC)
**Risk:** medium · **Effort:** 1 day · **Findings:** §6.1
`card-detail.tsx` is a modal (P3-1 will migrate the chrome) but also embeds
description editing, label management, blocker management, due-date picker, etc.
Extract one sub-component per concern as separate PRs (don't do all at once):
`<CardDescriptionEditor>`, `<CardBlockerList>`, `<CardDueDatePicker>`, `<CardTagPicker>`.

### P5-4 — Split `layout/project-overview.tsx` (664 LOC)
**Risk:** low · **Effort:** 1 day · **Findings:** §2.3
- After P3-4 (folder refactor) lands, decompose into sub-components in the same folder:
  `<OverviewStats>`, `<OverviewActivity>`, `<OverviewPinnedNotes>`, etc. The single
  `useProjectMetrics.ts` already exists — feed it through sub-components rather than
  inlining UI logic.

### P5-5 — Split `agent/SessionPane.tsx` (1009 LOC)
**Risk:** high · **Effort:** 3 days · **Findings:** §1 TL;DR, §2.1
Component makes 37 hook calls. Don't try to split it in one pass; extract one seam at
a time (e.g. file-diff rendering, terminal spawning, streaming state) into custom hooks
in `src/hooks/agent/`, leaving SessionPane orchestrating. Verify each extraction with
a manual spawn-and-edit run.

### P5-6 — Split `notes/notes-view.tsx` (1033 LOC)
**Risk:** medium · **Effort:** 2 days · **Findings:** §2.1
The view combines list + filter + folder tree + toolbar. The existing `useNoteFilter`
hook (covered by P3-6) is the seam. Extract `<NotesToolbar>`, `<NotesFolderTree>`,
`<NotesList>` into a `notes-view/` subfolder (same pattern as the chat-panel refactor
after P3-4).

### P5-7 — Split `flow/flow-view.tsx` (1019 LOC)
**Risk:** high · **Effort:** 3 days · **Findings:** §2.1
React Flow canvas + node CRUD + edge handling + dagre integration. Extract
`<FlowToolbar>`, `<FlowContextMenu>`, and move the create/update/delete flows behind a
`useFlowMutations` hook that delegates to `flow-commands.ts` (which already exists in
lib/commands).

### P5-8 — Split `notes/note-editor.tsx` (1283 LOC)
**Risk:** high · **Effort:** 3 days · **Findings:** §1 TL;DR #3, §2.1
The largest file in the renderer. Editor composition + AI toolbar + CodeMirror wiring +
autosave live in one component. After P3-3 (editorTheme + CM6 wrapper base) lands,
extract: `<NoteEditorToolbar>` (the AI text toolbar is already separate at 485 LOC but
could be split further), `<NoteEditorAutoSave>` hook, `<NoteEditorPersistGate>` for the
own-write guard. Don't attempt this until P3-1 (ModalShell) and P3-3 (CM6 wrapper
base) have proven the extraction pattern.

---

## P6 — Optional / Documentation

### P6-1 — Consolidate types in `src/types/`
**Risk:** low · **Effort:** 2 h · **Findings:** §2.5
Split `types/index.ts` (379 LOC) into per-entity files (`types/note.ts`,
`types/card.ts`, etc.) re-exported from the barrel. This is purely structural; no
behaviour change. Skip if it churns too many imports for too little gain.

### P6-2 — Fix file-naming convention
**Risk:** none · **Effort:** 2 h · **Findings:** §2.2
Pick kebab-case (recommended — matches Next.js App Router convention) **or** PascalCase
for component files. Rename the 20 kebab-case files (or the 77 PascalCase — kebab is
fewer renames). Keep each rename in its own PR to keep diffs reviewable.

### P6-3 — Test layout convention
**Risk:** none · **Effort:** 1 h · **Findings:** §7
Pick co-location or centralisation; document in CONTRIBUTING.md. Either keep the current
co-located convention and add a lint rule enforcing `.test.ts(x)?` lives next to source,
or move all tests to `tests/unit/`.

### P6-4 — Update CHANGELOG / AGENTS after each phase
**Risk:** none · **Effort:** ongoing
After each phase lands, update `changelogs/<version>.md` with the cleanup summary, and
update AGENTS.md sections that reference cleaned-up areas (key constraints, views &
navigation, store slices table, analytics canvas architecture section).

---

## Suggested Sequencing

```
Week 1   P0 (all)                — hygiene + safety net           ~3 days
Week 2-3 P1 (1→9, sequential)    — SQL consolidation              ~1.5 weeks
Week 4   P2 (1→4)                — IPC handlers.ts split          ~4 days
Week 5-6 P3 (any order, parallel) — component extractions         ~1 week
Week 7   P4 (1→7, incremental)    — canvas consistency             ~3 days
Week 8+  P5 (lowest-risk first)   — god-component splits           ongoing
as-time P6                        — optional / docs                ongoing
```

Total estimated "head-down" effort is ~6 weeks for P0–P4 and the lower-risk parts of P5.
The high-risk splits (P5-5, P5-7, P5-8) should be staged opportunistically —
 squeezing them into a single sprint raises regression risk.

---

## Verification Checklist (use after every PR)

```
npm run type-check:all      # after P0-3 — covers renderer + electron
npm run lint -- --max-warnings 0
npm test                    # vitest (includes electron tests after rebuild)
npm run compile             # esbuild bundles electron + mcp
npm run smoke-test          # after P1 items — exercises MCP tools
npx playwright test         # optional e2e
```

Manual smoke after risky changes (P1, P2-3, P5-x):
- Open Cairn, switch workspaces, create + edit + delete a note / card / project / tag.
- Open Idea Flow, create + connect + delete a node.
- Open Insights, switch canvases.
- Invoke the MCP server (`npm run mcp`) and call each tool that was migrated.

---

## What This Plan Does NOT Address (out of scope)

- New features (any) — including the half-built `codebase-*` tools front-end, the
  mobile-server UI, anything in changelogs marked "coming soon".
- Performance profiling — the analysis surfaced complexity, not perf hotspots.
- Dependency updates / major version bumps (e.g. React 19 → 20, Next 16 → 17).
- The agent loop logic itself (`electron/lib/pi-agent-loop.ts`, 747 LOC) — it's large
  but well-modularised; split only if it becomes obvious how.
- Schema redesign — `electron/db/schema.ts` migrations are disciplined and append-only;
  no schema work is proposed here.

These can be considered in a separate follow-up plan once P0–P5 have landed.
