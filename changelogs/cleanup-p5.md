## Cleanup (P5 — God-Component Splits, part 1)

Architectural-deep-dive cleanup (see `docs/cleanup/`). Phase P5 is the highest-risk
phase — God-component splits. Done in order of risk (lowest first), one seam at a time
per the plan. This changelog covers P5-1, P5-2, and P5-4. The remaining splits
(P5-3 card-detail, P5-6 notes-view, P5-5 SessionPane, P5-7 flow-view, P5-8 note-editor)
are staged for follow-up PRs.

### P5-1 — Relocate Pi Agent types to `types/index.ts`
- Moved `PiAgentMessage`, `PiSubagentMessage`, `TerminalSession`, and
  `PiSessionSummary` interface definitions from `store/slices/terminal-sessions.ts`
  into `src/types/index.ts` (where every other domain type lives).
- Updated consumers (`AgentMessageBubble`, `AgentChatPane`, `SessionPane`) to import
  from `@/types`.
- The slice re-exports the types for backwards compatibility.
- **terminal-sessions.ts**: 688 → 620 LOC (−68).

### P5-2 — Clean up `app/page.tsx`
- Extracted the inlined `UpdateBanner` (auto-updater install prompt) and
  `ErrorToasts` (IPC error toast stack) into `src/components/layout/app-chrome.tsx` —
  75 LOC of clean, self-contained presentational components.
- Removed the `Download`, `X`, `AlertCircle` icon imports from `page.tsx` (now in
  the chrome component).
- **page.tsx**: 410 → 341 LOC (−69).
- The main render is now readable: the shell (TitleBar + UpdateBanner + Sidebar +
  main view switch + RightPanel + SearchPanel + MigrationModal + ErrorToasts) is
  visible without scrolling.

### P5-4 — Decompose `project-overview/index.tsx`
- The 664-LOC file had 10 sub-components as free functions at the bottom of the file.
  Extracted them into two new files:

| New file | LOC | Exports |
|----------|----:|---------|
| `primitives.tsx` | 69 | `SectionHeader`, `StatCard`, `ProgressRing` (pure UI primitives) |
| `sections.tsx` | 214 | `ColumnBreakdownCard`, `PriorityBreakdownCard`, `ColumnPill`, `DueCard`, `PinnedNoteCard`, `NoteRow`, `RecentActivityFeed` (domain presentational components) |

- `index.tsx` is now a **427-LOC orchestrator** (−237 LOC, −36%) that owns state
  (chat input, edit popover, code dir) and wires the store to each section component.
- `useProjectMetrics.ts` (154 LOC) unchanged — already correctly isolated.
- The `EditProjectPopover` (stateful: 140 LOC of icon grid + description + status +
  priority editor) was left inline — it has its own effects for sync + outside-click,
  and extracting it would require passing `project` + `updateProject` + managing open
  state at the orchestrator (acceptable alternative but adds 2 props and 1 state at
  the orchestrator — not a clear win until someone needs to re-use the popover).

## Verification

- `npm run type-check:all` — clean.
- `npm run lint -- --max-warnings 0` — clean.
- `npm run compile` — clean.
- `npm test` — **430 tests pass across 18 files**.
