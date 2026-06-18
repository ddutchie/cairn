# Cairn Cleanup

Architectural deep-dive output: a survey of the codebase plus a phased cleanup plan.

## Contents

| File | Purpose |
|------|---------|
| [`findings.md`](./findings.md) | Survey of the codebase as of 2026-06-17 (v2.0.8). Identifies complexity hotspots, duplication, dead code, stale docs, and inconsistency. Organised by layer: renderer (`src/`), store, analytics canvases, Electron+IPC+MCP, cross-cutting modals/editors, tests, and a risk summary. |
| [`implementation-plan.md`](./implementation-plan.md) | Phased remediation plan with per-PR sizing, risk rating, verification steps, and sequencing. Seven phases (P0 hygiene → P5 god-component splits) plus a P6 optional/docs bucket. |

## How to use this

1. Read `findings.md` first — it establishes the vocabulary (god-components, ABI boundary, shared scaffold, etc.).
2. Work the phases in order: **P0** lowers risk for everything else; **P1** is the single biggest LOC saving (SQL consolidation across the Electron↔MCP boundary); each subsequent phase unlocks the next.
3. Each numbered item is sized to be its own PR (target ≤400 LOC diff). Verify with the checklist at the bottom of `implementation-plan.md` after every PR.

## Top items by impact (recap from findings §0)

1. ~1000 lines of duplicated SQL across the Electron↔MCP boundary — the boundary is fictional (see `findings.md §5.5`)
2. `electron/ipc/handlers.ts` 1054-line god-file mixing 7 domains
3. 6 god-components over 800 LOC (worst: `note-editor.tsx` 1283)
4. Analytics canvases: 4 inconsistent priority color/weight definitions, 1 dead export
5. Store hydration duplicated between `hydrate()` and `hydrateFromElectron()`
6. 8 modals with no shared `<ModalShell>`
7. 2 parallel "message bubble" implementations with byte-identical action tables
8. Dead `mcp-native/` folder + redundant `vitest-native/`
9. CI never type-checks electron code; `tsconfig.mcp.json` is superficial
10. Orphaned/dead tests (`GraphAIPanel.test.ts`, `tool-parity.test.ts`)
