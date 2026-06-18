## Cleanup (P3 — Component Extractions)

Architectural-deep-dive cleanup (see `docs/cleanup/`). Phase P3 addresses the
scattered component patterns: duplicated shared chrome, half-finished folder
refactors, cross-feature imports, hooks mixed into views, and byte-identical
constants living in two files. 6 independent items; each is its own migration.

### P3-5 — Consolidate graph helpers
- `resolveCssVar` (the only export in `graphUtils.ts`, 12 lines) moved into
  `analyticsUtils.ts`. `graphUtils.ts` **deleted**. Graph helper modules
  reduced from 4 → 3 (`analyticsUtils.ts`, `analyticsHooks.ts`, `graph-ai-utils.ts`).
- Updated imports in `ForceGraphCanvas.tsx` and `RadialTreeCanvas.tsx`.

### P3-3 — Promote `editorTheme.ts` to `lib/`
- `src/components/agent/editorTheme.ts` → `src/lib/editor-theme.ts`.
- This was a cross-feature dependency: `notes/markdown-editor.tsx` was importing
  from `@/components/agent/editorTheme` — now both `agent/FileEditorInner.tsx`
  and `notes/markdown-editor.tsx` import from `@/lib/editor-theme`.

### P3-4 — Finish `chat-panel/` + `project-overview/` folder refactor
- `src/components/chat/chat-panel.tsx` (480 LOC) → `chat-panel/index.tsx`.
  Sub-folder imports updated from `./chat-panel/*` to `./` (siblings).
  Parent-folder import `ChatInput` updated to `../ChatInput`.
- `src/components/layout/project-overview.tsx` (664 LOC) → `project-overview/index.tsx`.
  `useProjectMetrics` import updated from `./project-overview/useProjectMetrics` to
  `./useProjectMetrics`.
- External consumers (`SessionPane.tsx`, `app/page.tsx`) import paths unchanged —
  `@/components/chat/chat-panel` and `@/components/layout/project-overview` now
  resolve to the folder's `index.tsx` automatically.

### P3-6 — Centralise hooks (extract inline `useIpcErrorToasts`)
- Extracted `useIpcErrorToasts` from `src/app/page.tsx` (was defined inline at
  lines 19–41, causing imports to appear mid-file after the hook definition) →
  `src/hooks/useIpcErrorToasts.ts`.
- Fixed the mid-file imports code smell: all imports now at the top of `page.tsx`.
- Removed the duplicate import block that existed below the inline hook.
- Co-located single-consumer hooks (`useProjectMetrics`, `useNoteFilter`) left where
  they are — co-location with a single consumer is a valid pattern (same as
  `useHistory` in `lib/history.ts`). The only scattered hook was the inline one.

### P3-1 — Extract `<ModalShell>` + migrate 2 simplest modals
- Created `src/components/ui/modal-shell.tsx` — a `<ModalShell>` component on top
  of the existing `ui/dialog.tsx` Radix primitive. Props: `{ open, onClose,
  dismissGuard, size, title, description, scrollable, footer, contentClassName }`.
  Normalizes the chrome shared by 6 of 8 modals: open/onClose binding, size, auto
  close-X, icon-in-title, sr-only description (accessibility), scrollable flex body,
  optional footer.
- Migrated `MoveNoteModal.tsx` (50 → 44 lines) and `DashboardApiModal.tsx`
  (163 → 155 lines) to `<ModalShell>`.
- The remaining 6 modals (`DashboardTemplateModal`, `MigrationModal`, `PrdModal`,
  `SpawnAgentModal`, `NodeEditModal`, `card-detail`) left for incremental migration
  in future PRs. `MigrationModal` (blocking, non-dismissible) and `card-detail`
  (VisuallyHidden title, two-column body) are structurally different and may stay
  bespoke.

### P3-2 — Extract shared `CairnRefChip` + action lookup tables
- Created `src/components/shared/cairn-ref-chip.tsx` exporting:
  - `CAIRN_NOTE_ACTIONS` (6-entry lookup table: `{ create_note: "Created note", … }`)
  - `CAIRN_TASK_ACTIONS` (4-entry lookup table: `{ create_task: "Created task", … }`)
  - `<CairnRefChip toolName={...} cairnRef={...} ok={...} />` — the clickable
    chip that results from a tool call writing a note or task.
- `AgentMessageBubble.tsx` (395 → 320 LOC, −75 lines) — removed the local
  `CairnRefChip` function + the two lookup tables + the imports for `CairnEvents`
  and `SquareCheck` (now in the shared module).
- `ChatMessageBubble.tsx` (180 → ~100 LOC, −80 lines) — removed the same tables
  + the 58-line `ChatToolCallChip` cairn-ref branch (replaced with a one-liner
  `<CairnRefChip>` call). The non-cairn-ref branch of `ChatToolCallChip` (a
  simple label chip without a reference) stays inline since it's 5 lines.
- Removed unused imports (`useCairnStore`, `CairnEvents`, `SquareCheck`) from
  both files. The shared `<CairnRefChip>` owns the store lookup and event dispatch.

## Verification

- `npm run type-check:all` — clean (renderer + electron).
- `npm run lint -- --max-warnings 0` — clean.
- `npm run compile` — clean.
- `npm test` — **430 tests pass across 18 files**.
