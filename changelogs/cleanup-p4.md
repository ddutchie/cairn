## Cleanup (P4 — Analytics Canvas Consistency)

Architectural-deep-dive cleanup (see `docs/cleanup/`). Phase P4 makes the 7
analytics canvases consistently use their own shared scaffold. Before P4,
Beeswarm was the only canvas that fully complied; the other 6 deviated in
priority colors, sort weights, empty states, pointer math, and tick rendering.

### P4-1 — Unify priority colors + sort weights
- **Removed 4 duplicate definitions** of priority color maps and sort weights:
  - `TimelineCanvas.tsx`: local `PRIORITY_COLOR` ({low→`--success`} differed from shared) + local `PRIORITY_ORDER`
  - `TableCanvas.tsx`: inline ternary chain for priority colors + local `PRIORITY_ORDER`
  - `SankeyCanvas.tsx`: local `po` map (was same direction as `PRIORITY_WEIGHT` but a separate variable)
- All canvases now import `PRIORITY_COLOR` and `PRIORITY_SORT_ORDER` from `analyticsUtils.ts`.
- Added new `PRIORITY_SORT_ORDER` export (ascending: urgent=0, low=3) alongside the
  existing `PRIORITY_WEIGHT` (descending: low=0, urgent=3) — each canvas picks the one
  matching its sort direction. `PRIORITY_WEIGHT` is no longer dead.

### P4-2 — Remove dead props from shared components
- `CanvasTooltip`: removed unused `containerH?` prop (declared, destructured, never read).
- `SvgTimeAxis`: removed unused `plotH` prop (destructured as `_plotH`, never referenced).

### P4-3 — Extract `useRelativePointer` + `useNow` hooks
- **`useRelativePointer(ref)`** — returns `(e) => { x, y }` via `getBoundingClientRect()`.
  Replaces 3 inline occurrences (Beeswarm ×1, Ridgeline ×2).
- **`useNow(refreshMs?)`** — returns `Date.now()` via `useState` (updates on interval
  when `refreshMs` is provided). Replaces 3 inline `Date.now()` calls that triggered
  `react-hooks/purity` eslint disables (Bullet ×1, Ridgeline ×2). All 3 disables removed.
- Both hooks added to `analyticsHooks.ts`.

### P4-4 — Use `<SvgTimeAxis>` in RidgelineCanvas
- Replaced ~22 lines of inlined tick grid + "today" line (nearly byte-for-byte
  identical to `<SvgTimeAxis>` internals) with a single `<SvgTimeAxis>` call.
- Removed unused `ticks` useMemo (the component generates its own ticks internally)
  and unused `tickColor` constant.

### P4-5 — Unify empty states
- `TimelineCanvas.tsx`: replaced 7-line inline empty-state JSX with `<CanvasEmptyState>`.
- `MatrixCanvas.tsx`: replaced 5-line inline empty-state with `<CanvasEmptyState>`.
- `TableCanvas.tsx`: left its `<tr><td>` empty state as-is (semantically correct for an
  HTML table — `<CanvasEmptyState>` is absolutely positioned and would break table layout).

### P4-6 — Merge dual imports in BeeswarmCanvas
- Two separate import statements from `./analyticsUtils` (lines 7 and 10) merged into one.

## Verification

- `npm run type-check:all` — clean.
- `npm run lint -- --max-warnings 0` — clean (all 4 `react-hooks/purity` disables removed).
- `npm run compile` — clean.
- `npm test` — **430 tests pass across 18 files**.
