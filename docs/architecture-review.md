# Cairn Architecture Review — Shared Components & Cleanup Opportunities

> Scope: whole-app deep dive across `src/components/`, `src/lib/`, `src/store/`, `src/hooks/`.
> Goal: surface duplicated logic, missing shared primitives, oversized modules, and cleanup targets.
> Line numbers reflect the state of the tree at time of writing and may drift.

## How to read this doc

Each finding is tagged with an impact/effort estimate:

- **Impact**: High = removes real duplication / bug surface across many sites; Med = localized win; Low = polish.
- **Effort**: S (<1h), M (a few hours), L (multi-session refactor).

Recommendations are ordered so the high-impact / low-effort items come first.

## Progress log

**Wave 1 — COMPLETE** (all items shipped; `type-check:all`, 836 tests, and `npm run compile` green):

- ✅ 2.1 `getIsDark()` (`lib/utils.ts`) + `useIsDark()` (`hooks/useIsDark.ts`); migrated 7 read sites and replaced the 2 canvas MutationObserver blocks with `useThemeRepaint()` (`analyticsHooks.ts`). Also fixed a latent stale-theme bug: `CodeBlock`, `AgentEditor`, `DiffViewer`, `GitView` now re-render on live theme switch.
- ✅ 2.2 `useCopyToClipboard()` (`hooks/useCopyToClipboard.ts`); migrated `CodeBlock`, `DashboardApiModal`, `StepMCP`, `AgentSettings`, `ChatMessageBubble`, `DiffViewer`, `MCPSettings` (×2, keyed). (`AISettings` fire-and-forget copy left as-is — no `copied` state to consolidate.)
- ✅ 2.3 `navigateAndReveal()` + `revealNote/revealCard/revealColumn()` (`lib/events.ts`); migrated 13 sites across chat, kanban, preview, agent, project-overview, search, and flow nodes. Fixed the no-timeout race variants in `useProjectMetrics`, `project-overview/index`, `search-panel`, and the flow ref nodes.
- ✅ 2.4 Unified priority/status colour maps: `PRIORITY_CSS_COLORS` is the canonical CSS-var map (`analyticsUtils.PRIORITY_COLOR` now re-exports it); fixed the `PRIORITY_COLORS` Tailwind `medium` hue (was `--warning`, now `--info`) to match; `STATUS_COLORS` moved to `constants.ts` (re-exported from `utils.ts`).
- ✅ 5 `withAlpha()` moved to `analyticsUtils.ts`; removed both byte-identical copies in `ForceGraphCanvas`/`RadialTreeCanvas`.

**Wave 2 — COMPLETE** (`type-check:all`, 836 tests, and `npm run compile` green):

- ✅ 4.1 Merged `card-detail.tsx` + `card-detail-panel.tsx` into a shared `card-detail-body.tsx` (`CardDetailBody`). Wrappers dropped from 236/225 lines to 48/22; the panel now uses the shared blocker utils (fixing the flagged inconsistency).
- ✅ 4.3 Converged the syntax-highlight palette into `lib/syntax-palette.ts` (`SYNTAX_COLORS` + derived `DARK_TO_LIGHT`). Four consumers now derive from it: `CodeBlock`, `lib/editor-theme.ts`, `dashboard-view`, and the note PDF export. Verified the generated `CodeBlock` palettes are byte-identical to the originals (zero visual change).
- ✅ 2.7 Added `ui/toggle.tsx`; `settings/shared.tsx Toggle` now wraps it, and `ViewVisibilitySettings`'s local toggle was removed. (Onboarding/ToolsSettings toggles with bespoke labels/sizing left as-is.)
- ✅ 5 Added `<NodeTypeChip>` (`graph/NodeTypeChip.tsx`), supporting both filter-toggle and static-label modes; migrated `InsightsView`, `KnowledgeGraphView`, and `TableCanvas`. (`GraphDetailPanel`'s icon+label chip left as-is — not a clean fit.)
- ✅ 3.1 Replaced inline bot avatars in `ToolCallIndicator`/`QuestionForm` with `MessageAvatar`, and inline streaming cursors in `ToolCallIndicator`/`ThinkingPanel` with `StreamingCursor`.

Deferred to Wave 3 (higher risk): the full `useMarkdownComponents()` factory (3.2/4.2 — the three ReactMarkdown override maps have genuinely different feature sets), the tool-call chip unification (3.2), and `<PriorityBadge>`/`<SearchInput>`/`<TagPicker>`/`<ArchivedSection>` (2.4/4.4 — lower value now that colour maps are unified).

**Wave 3** — partial (`type-check:all`, 836 tests, and `npm run compile` green):

- ✅ 7 Store hydration de-dup: extracted `restorePersistedTheme()` + `restorePersistedUiPrefs()` in `store/index.ts`; both hydration paths call them (removed ~40 duplicated lines). AI/agent config restore left inline (the electron path genuinely differs — backend fetch + localLLM probe).
- ✅ 6/4.2 Extracted PDF-export HTML prep from `note-editor.tsx` into `note-pdf-export.ts` (`prepareNoteHtmlForPdf` + `pdfSafeTitle`).
- ✅ 4.2 Extracted the shared ReactMarkdown `pre`→CodeBlock/Mermaid handler into `notes/markdown-code-fence.tsx` (`renderCodeFence`); migrated note-editor, NoteMarkdownPreview, and chat MarkdownContent. (The broader per-surface override maps genuinely differ and were left in place.)
- ✅ 6 Decomposed `board.tsx` (657→549): extracted the inline archive-view IIFE into `kanban/archive-view.tsx` (`<ArchiveView>`).
- ⏭️ **Skipped by decision** — splitting `terminal-sessions.ts` (highest risk, touches streaming-message mutations, no user-facing benefit).
- ⏭️ **Deferred** — decomposing `GitView.tsx` (1100 lines, tightly-coupled git state; lowest reward-to-risk); the full `useMarkdownComponents()` factory beyond the shared `pre` handler (the override maps legitimately differ per surface).


---

## 1. Executive summary

The codebase is generally well-factored: there is a real `ui/` primitive layer (Radix-based `Button`, `Dialog`, `DropdownMenu`, `Tooltip`, `Badge`, `SegmentedControl`, `ModalShell`), a shared analytics scaffold (`analyticsUtils`/`analyticsHooks`/`AnalyticsShared`), a shared markdown pipeline (`lib/markdown/pipeline.tsx`), and an undo/redo command layer (`lib/commands/*`). Slices correctly funnel DB access through `store/ipc.ts` helpers.

The problems are concentrated in a handful of **cross-cutting idioms that were copy-pasted before a shared helper existed**, plus a few **god components/slices**. The biggest wins are small hooks/helpers that each collapse 5–10 duplicated call sites:

1. `useIsDark()` — 6 inline `getAttribute("data-theme")` reads + 3 MutationObserver blocks.
2. `useCopyToClipboard()` / `<CopyButton>` — 6–9 copy-with-timeout-reset blocks.
3. `navigateAndReveal()` — 8+ `setView(...) + setTimeout(dispatch CairnEvents, 50)` sites.
4. Merge `card-detail.tsx` + `card-detail-panel.tsx` (~95% duplicate, ~180 lines).
5. Unify the three priority-color tables and two status-color tables.

The largest structural debt is a small number of oversized files: `GitView.tsx` (1100), `note-editor.tsx` (1098), `flow-view.tsx` (875), and the `terminal-sessions.ts` slice (692, mixes three concerns).

---

## 2. Cross-cutting duplicated idioms (highest leverage)

### 2.1 Theme detection — no `useIsDark()` — Impact: High, Effort: S

The expression `document.documentElement.getAttribute("data-theme") !== "light"` is inlined in 6 files, and the "observe `data-theme` mutations and repaint" effect is duplicated in the two canvas-2D renderers.

Read sites:
- `src/components/notes/CodeBlock.tsx:163`
- `src/components/notes/MermaidDiagram.tsx:32`
- `src/components/notes/dashboard-view.tsx:36`, `:161`
- `src/components/agent/AgentEditor.tsx:46`
- `src/components/agent/DiffViewer.tsx:48`
- `src/components/agent/GitView.tsx:1064`

MutationObserver repaint (near-identical: `documentElement` → observe `data-theme` → double-`requestAnimationFrame` → `drawRef.current()`):
- `src/components/graph/ForceGraphCanvas.tsx:466-491`
- `src/components/graph/RadialTreeCanvas.tsx:498-523`
- also a watcher in `src/components/notes/dashboard-view.tsx:73-79`

**Recommendation.** Add to `lib/` (and re-export a hook):
- `getIsDark(): boolean` — pure read for imperative call sites (canvas draw, CodeMirror theme build).
- `useIsDark(): boolean` — subscribes to a `data-theme` MutationObserver, re-renders on change.
- For canvases, add `useThemeRepaint(drawRef)` to `analyticsHooks.ts` to replace the two repaint effects.

Note: `lib/editor-theme.ts:18 buildHighlightStyle(isDark)` already takes `isDark` as a parameter — feed it from `getIsDark()`.

### 2.2 Copy-to-clipboard with reset — no shared hook — Impact: High, Effort: S

Same `setCopied(true)` → `setTimeout(() => setCopied(false), N)` pattern, with `N` inconsistent (2000 in most, 1800 in one, missing entirely in a couple):
- `src/components/notes/CodeBlock.tsx:184`
- `src/components/notes/DashboardApiModal.tsx:77` (1800ms)
- `src/components/onboarding/StepMCP.tsx:35`
- `src/components/settings/AgentSettings.tsx:201`
- `src/components/settings/MCPSettings.tsx:44`, `:202` (two in one file)
- `src/components/chat/chat-panel/ChatMessageBubble.tsx:39`
- `src/components/agent/DiffViewer.tsx:111`
- `src/components/settings/AISettings.tsx` (fire-and-forget, no reset — inconsistency)

**Recommendation.** `useCopyToClipboard(resetMs = 2000): { copied, copy }` in `src/hooks/`, plus an optional `<CopyButton value={...} />` in `ui/`. There is no clipboard helper in `lib/utils.ts` today.

### 2.3 `setView + setTimeout(dispatch CairnEvents, 50)` navigation — Impact: High, Effort: S

The "switch view, then after 50ms fire a CairnEvent to select/scroll" race workaround is copy-pasted with a magic `50`:
- `src/components/shared/cairn-ref-chip.tsx:66`, `:70`
- `src/components/kanban/card-detail.tsx:175`
- `src/components/kanban/card-detail-panel.tsx:166`
- `src/components/chat/PreviewPane.tsx:83`, `:86`
- `src/components/chat/chat-panel/MarkdownContent.tsx:181`, `:200`
- `src/components/agent/AgentChatPane.tsx:601`
- `src/components/layout/project-overview/sections.tsx:37`
- `src/components/layout/project-overview/index.tsx:339` (and immediate, no-timeout variants at `:352`/`:365`/`:378` — a latent inconsistency/bug source)

**Recommendation.** A single helper co-located with the event bus, e.g. `navigateAndReveal(setView, view, () => CairnEvents.selectNote(id))` in `lib/events.ts`, encapsulating the deferred dispatch. Removes the magic number and normalizes the no-timeout variants.

### 2.4 Fragmented priority / status color maps — Impact: Med, Effort: S

Three competing priority-color tables and two status tables exist:
- `lib/constants.ts:52 PRIORITY_COLORS` (Tailwind `text-` classes)
- `lib/constants.ts:63 PRIORITY_CSS_COLORS` (CSS-var strings)
- `graph/analyticsUtils.ts:40 PRIORITY_COLOR` (CSS-var strings — a third)
- `lib/constants.ts:74 STATUS_CSS_COLORS` vs `lib/utils.ts:76 STATUS_COLORS` (overlapping)

Plus `kanban/board.tsx:488-497` hardcodes priority→color inline (`bg-[var(--danger)]/10`) instead of any of them, using `/10` opacity shorthand where the rest of the app uses `color-mix`.

**Recommendation.** One canonical priority table in `lib/constants.ts` exposing both a class map and a CSS-var map derived from a single source; delete `analyticsUtils.PRIORITY_COLOR` and `utils.STATUS_COLORS` in favour of the constants versions. Introduce a `<PriorityBadge priority>` and `<NodeTypeChip type>` to stop the color logic leaking into JSX.

### 2.5 Drag-to-resize mouse handlers — no `useResizable()` — Impact: Med, Effort: M

The manual `mousedown → mousemove → document.body.style.cursor` pattern is reimplemented in:
- `src/components/chat/UnifiedChatPanel.tsx:54-91`
- `src/components/chat/PreviewPane.tsx:56-100`
- `src/components/notes/notes-view.tsx:108`, `:510`
- `src/components/agent/AgentView.tsx:108`, `:120` (col + row resize)

**Recommendation.** `useResizable({ axis, min, max, onChange })` hook returning handle props, or a `<ResizeHandle>` component.

### 2.6 Inline outside-click dropdowns bypass `ui/dropdown.tsx` — Impact: Med, Effort: M

`ui/dropdown.tsx` is a full-featured Radix menu (incl. checkbox items), yet at least 8 sites hand-roll `open` state + `contains(e.target)` outside-click:
- `src/components/flow/flow-view.tsx:217`
- `src/components/agent/AIChatTab.tsx:44`, `AgentSessionTab.tsx:40`, `SessionPane.tsx:88`
- `src/components/notes/BacklinksPanel.tsx:307`
- `src/components/chat/chat-panel/index.tsx:504`
- `src/components/layout/project-overview/index.tsx:117`
- `src/components/settings/TagsSettings.tsx:37`

`layout/QuickSettings.tsx` correctly uses the Radix `DropdownMenu` — use it as the migration reference. (`ui/date-picker.tsx`'s own popover is acceptable; it is a primitive.)

### 2.7 Missing `ui/toggle.tsx` — Impact: Med, Effort: S

No shared switch primitive. The `role="switch"` + `inline-flex h-5 w-9 rounded-full` markup is reimplemented ~7×:
- `settings/shared.tsx:61` (`Toggle` — closest to canonical)
- `settings/ViewVisibilitySettings.tsx:18`, `settings/ToolsSettings.tsx:444`, `:542`
- `onboarding/StepAISetup.tsx:76`, `onboarding/StepEmbeddings.tsx:143`
- `layout/project-overview/ToolsAttachPanel.tsx:127`

**Recommendation.** Promote `settings/shared.tsx` `Toggle` to `ui/toggle.tsx` and migrate the rest.

### 2.8 Duplicate `formatDate` + raw `toLocaleDateString` — Impact: Low, Effort: S

`lib/utils.ts` already exports `formatDate`, `formatRelative`, `getDueDateStatus`. But:
- `agent/sessionUtils.ts:3` defines its **own** `formatDate` (different impl) used by `AgentSessionTab`/`AgentEmptyState`.
- Raw `toLocaleDateString`/`toLocaleString` bypass the helpers in `graph/TimelineCanvas.tsx:24`, `graph/TableCanvas.tsx:148`, `kanban/board.tsx:500`, `agent/GitView.tsx:914`, `chat/chat-panel/index.tsx:225`, `notes/notes-view/PrdModal.tsx:270`, and others.

**Recommendation.** Merge `sessionUtils.formatDate` into `lib/utils.ts` (add a variant if the month/day format is genuinely needed); route raw calls through the helpers.

---

## 3. Message-rendering subsystem (chat/ + agent/)

Both message bubbles already share the right primitives: `MarkdownContent`, `MessageAvatar`, `StreamingCursor`, `ThinkingPanel` (all from `chat/chat-panel/`), and `CairnRefChip` (from `shared/`). `agent/AgentMessageBubble.tsx` imports the chat renderer rather than duplicating it. Good.

Remaining duplication:

### 3.1 Avatar & streaming-cursor reimplemented inline — Impact: Med, Effort: S
`message-ui.tsx` exports `MessageAvatar` and `StreamingCursor`, but:
- Bot avatar markup is hardcoded in `chat/chat-panel/ToolCallIndicator.tsx` and `chat/chat-panel/QuestionForm.tsx` (the latter's comment even says "mirrors ChatMessageBubble assistant style").
- The blinking cursor `<span>` is inlined in `ThinkingPanel.tsx` and `ToolCallIndicator.tsx` instead of `StreamingCursor`.

**Recommendation.** Replace inline copies with `MessageAvatar` / `StreamingCursor`.

### 3.2 Three tool-call chip implementations — Impact: Med, Effort: M
- `chat/chat-panel/ChatMessageBubble.tsx` → `ChatToolCallChip` (label + cairn-ref only)
- `chat/chat-panel/ToolCallIndicator.tsx` → live variant (running/done)
- `agent/AgentMessageBubble.tsx` → `ToolChip` (richest: confirm/deny, running, expandable output, inline diff)

**Recommendation.** Extract a `<ToolCallChip>` with props for the optional confirm/expand/running features so all three funnel through one component.

### 3.3 Bespoke diff parser vs `parse-diff` — Impact: Low, Effort: M
`agent/AgentMessageBubble.tsx` `parseDiff` is a hand-rolled string-prefix heuristic, unrelated to the `parse-diff` npm lib used by `DiffViewer`/`DiffFile`/`GitView`. Consider routing tool-output diffs through the same `DiffFile` primitives.

### 3.4 xterm terminal init duplicated — Impact: Med, Effort: M
`agent/SessionMount.tsx` and `agent/AgentBottomTerminal.tsx` each contain ~80 lines of near-identical xterm construction (theme from CSS vars, FitAddon + Unicode11, ResizeObserver, onData/onResize/onExit). Extract a `createXterm(opts)` factory / `useXterm()` hook. (`AgentBottomTerminal` intentionally stays out of `TerminalManager` — preserve that.)

### 3.5 `saveMessages` persistence duplicated — Impact: Low, Effort: S
`agent/AgentChatPane.tsx` `onDone` (~L251) and `onError` (~L279) repeat the transcript-persist block. Extract a local `persistTranscript()`.

---

## 4. Notes & Kanban

### 4.1 `card-detail.tsx` ≈ `card-detail-panel.tsx` (~95% duplicate) — Impact: High, Effort: M
Both share identical store selectors, `useMemo` derivations, and Title/Description/Tags/Linked-notes JSX (~150 lines each). Only the wrapper differs (`<Dialog>` vs `<div>`). Worse, `card-detail-panel.tsx:55-60` re-inlines blocker logic instead of importing `card-detail-utils.ts`.

**Recommendation.** Extract `<CardDetailBody>`; have both wrappers render it. Make the panel use `card-detail-utils.ts`. Removes ~180 duplicated lines.

### 4.2 Three parallel ReactMarkdown override maps — Impact: High, Effort: M
The `pre`→CodeBlock/Mermaid switch + element overrides exist in three places:
- `notes/note-editor.tsx:445-683` (full/interactive: checkboxes, wikilinks, heading slugs)
- `notes/NoteMarkdownPreview.tsx:178-240` (stateless subset)
- `chat/chat-panel/MarkdownContent.tsx:130-250` (chat variant, uses only gfm/breaks/raw — does NOT use `lib/markdown/pipeline.tsx`)

The `pre` handler is the same 8 lines in all three. `NoteMarkdownPreview` is already the de-facto shared renderer (8 consumers incl. kanban, graph, flow, settings), but `note-editor` and chat re-implement.

**Recommendation.** Extract a `useMarkdownComponents({ interactive })` factory returning the overrides map; converge chat markdown onto `lib/markdown/pipeline.tsx` plugins where feature parity is wanted (callouts, wikilinks, LaTeX are currently missing in chat).

### 4.3 One syntax-highlight palette, three copies — Impact: Med, Effort: S
The lowlight palette hexes (`#c678dd`, `#98c379`, ...) appear in:
- `notes/CodeBlock.tsx` (`DARK`/`LIGHT`)
- `notes/dashboard-view.tsx:164-188` (CodeMirror `HighlightStyle`, comment: "Palette matched to CodeBlock.tsx")
- `notes/note-editor.tsx:729-733` (`DARK_TO_LIGHT` PDF-export remap)

**Recommendation.** Export one palette constant (alongside `CodeBlock` or in `lib/editor-theme.ts`) and reference it in all three.

### 4.4 Repeated tag pickers / search inputs / archived sections — Impact: Med, Effort: M
- Tag toggle grid duplicated in `card-detail.tsx:130-162`, `card-detail-panel.tsx:121-153`; different tag pickers in `BacklinksPanel.tsx (NoteTagBar)` and `notes-view.tsx:370`. → `<TagPicker>` / `<TagToggleGrid>`.
- Search input markup (`<Search icon> + input`) repeated in `board.tsx:385`, `:431`, `notes-view.tsx:355`. → `<SearchInput>`.
- Archived-section collapse pattern in `column.tsx:338`, `notes-view.tsx:483`, `board.tsx:456`. → `<ArchivedSection>`.
- `card-detail-sidebar.tsx:18` redefines `PRIORITY_OPTIONS` locally despite `constants.ts:38`.

---

## 5. Graph & Insights

Shared scaffold (`analyticsUtils.ts`, `analyticsHooks.ts`, `AnalyticsShared.tsx`) is adopted well by the SVG canvases. Remaining items:

- **`withAlpha()` duplicated byte-for-byte** in `graph/ForceGraphCanvas.tsx:59-71` and `graph/RadialTreeCanvas.tsx:92-103`. → move into `analyticsUtils.ts` next to `resolveCssVar`. (Impact: Med, Effort: S)
- **Node-type filter/legend chip** duplicated: `insights/InsightsView.tsx:213-231`, `graph/KnowledgeGraphView.tsx:440-460`, `graph/GraphDetailPanel.tsx:185`, `graph/TableCanvas.tsx:169`. → `<NodeTypeChip>` (pairs with the color-map unification in §2.4). (Impact: Med, Effort: S)
- **Theme repaint effect** (§2.1) in the two canvas-2D files → `useThemeRepaint(drawRef)`.
- `insights/InsightsView.tsx:240-251` inline segmented control → reuse `ui/segmented-control.tsx`.

---

## 6. Oversized modules to decompose

| File | Lines | Concern |
|------|-------|---------|
| `agent/GitView.tsx` | 1100 | Branch switcher + PR + staged/unstaged/untracked sections + inline diffs + commit form + AI messages, all in one file with inline `FileSection`/`FileRow`/`Inlinediff`. |
| `notes/note-editor.tsx` | 1098 | Save/debounce + title edit + wikilink detection + AI actions + spawn-tasks + ~20 markdown overrides + ~90-line PDF export. Extract `useMarkdownComponents`, `exportNotePdf`, spawn-tasks handler. |
| `flow/flow-view.tsx` | 875 | React Flow canvas + inline add-menu dropdown + color maps. |
| `settings/ToolsSettings.tsx` | 796 | Multiple settings surfaces + toggle/copy duplication. |
| `settings/AISettings.tsx` | 743 | — |
| `agent/AgentChatPane.tsx` | 702 | ~20 IPC subscriptions + duplicated save blocks. |
| `store/slices/terminal-sessions.ts` | 692 | **Mixes 3 concerns**: terminal sessions + Pi agent conversation model (messages/tools/subagents/usage) + editor tab strip. Split into `terminal-sessions` / `pi-agent-messages` / `editor-tabs`. |
| `kanban/board.tsx` | 657 | Inline archive-view IIFE (416-532) → `<ArchiveView>`; drag-zone logic → hook. |
| `chat/chat-panel/index.tsx` | 657 | Orchestration + inline system prompt + `formatChatHistory` + archive routine + popout dropdown. |

---

## 7. Store & lib cleanups

- **Hydration duplication.** `store/index.ts` `hydrate()` (~L160) and `hydrateFromElectron()` (~L237) each re-read theme/fontScale/aiConfig/agentConfig/hiddenViews/seenFeatures/widths — ~60 near-identical lines. Extract `restorePersistedUiState()`. (Impact: Med, Effort: S)
- **`ui.ts` (363) mixes concerns.** Theme + font scale + view visibility + panel widths + tutorial + AI/Agent config setters. Consider extracting AI/Agent config into its own slice. (Impact: Low, Effort: M)
- **Debounce.** No shared imperative `debounce()`; only `useDebouncedValue` (used once, in `BacklinksPanel`). Ad-hoc `setTimeout` debouncers in `note-editor.tsx:213`/`:249`, `search-panel.tsx:170`/`:177`, `ChatInput.tsx:119`. Add `useDebouncedCallback`. (Impact: Low, Effort: S)
- IPC helpers (`ipc`/`ipcAwait`/`ipcAwaitResult`) are consistently imported from `store/ipc.ts` — no action needed.

---

## 8. Suggested sequencing

**Wave 1 — low-effort, high-payoff hooks/helpers (mostly mechanical):**
1. `useIsDark()` + `getIsDark()` (§2.1)
2. `useCopyToClipboard()` (§2.2)
3. `navigateAndReveal()` (§2.3)
4. Move `withAlpha()` to `analyticsUtils.ts` (§5)
5. Unify priority/status color maps (§2.4)

**Wave 2 — component extractions:**
6. `<CardDetailBody>` merge (§4.1)
7. `useMarkdownComponents()` + converge palettes (§4.2, §4.3)
8. `<PriorityBadge>`, `<NodeTypeChip>`, `<TagPicker>`, `<SearchInput>`, `ui/toggle.tsx` (§2.4, §2.7, §4.4, §5)
9. Replace inline avatars/cursors/tool-chips (§3.1, §3.2)

**Wave 3 — structural refactors (schedule deliberately):**
10. Split `terminal-sessions.ts` slice (§6)
11. Decompose `GitView.tsx`, `note-editor.tsx`, `kanban/board.tsx` (§6)
12. `useResizable()` + migrate inline dropdowns to `ui/dropdown.tsx` (§2.5, §2.6)
13. `createXterm()` factory (§3.4)

Each Wave-1 item is independently shippable and should be followed by `npm run type-check:all`.

---

## 9. Verification notes

Counts spot-checked against the tree: `getAttribute("data-theme")` reads found in 6 component files; `setCopied(false)` reset blocks in 5+ files (one at 1800ms, confirming the inconsistency); `withAlpha` defined as a `function` in both canvas files. Largest files by `wc -l` confirm the §6 table.
