<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Cairn — Agent Architecture Guide

## Stack summary

- **Electron + Next.js 16** (App Router, static export) — desktop app
- **Tailwind CSS v4** — all colours via CSS custom properties (`var(--token)`), never raw Tailwind colour names
- **Zustand** — domain slices in `src/store/slices/`; composed in `src/store/index.ts`
- **better-sqlite3** — dual ABI (Electron + pkg/Node 24), arch-separated (arm64 + x64); all DB access goes through IPC from the renderer
- **D3 v7.9.0** — all SVG analytics rendering

## Styling rules

- **All colours** must use CSS variables: `var(--background)`, `var(--accent)`, `var(--text-primary)`, etc.
- **Alpha variants**: `color-mix(in srgb, var(--token) X%, transparent)` — never hardcode `rgba()`
- **Font sizes**: use `rem`-based Tailwind classes (`text-xs`, `text-sm`, `text-[0.714rem]`, etc.). Never use `text-[Npx]` — pixel classes don't scale with the font size setting.
- **Font scaling**: `--font-scale` CSS variable is set on `<html>` inline by `applyFontScale()`. Root `font-size: calc(14px * var(--font-scale))`. SVG `fontSize` attributes must be multiplied by `useFontScale()` from `analyticsHooks.ts`.
- **better-sqlite3 ABI**: the only ABI-sensitive operation is constructing the `Database` instance via `new Database(dbPath, { nativeBinding })`. That happens once in `electron/db/client.ts` (Electron ABI, `electron-native/<arch>/`) for the main process and once in `mcp-server.ts` (pkg Node 24 ABI, `pkg-native/<arch>/`) for the MCP runtime. Binaries are arch-separated (arm64 + x64), downloaded as prebuilts by `scripts/rebuild-native.js`, and resolved at runtime via `process.arch` — so a single macOS build ships both arches. The standalone `cairn-mcp` binary must run independently of the app (so agents can read/write the workspace while Cairn is closed), which is why it bundles its own Node runtime + sqlite rather than reusing the Electron one. Helper functions in `electron/db/queries.ts` and `electron/db/graph-queries.ts` may be imported from `electron/mcp/tools/*` — they run on the already-constructed `db` handle regardless of which TS file defines them (see `electron/mcp/tools/codebase.ts`, which already does `import * as q from "../../db/queries"`). Never construct a `Database` outside those two bootstrap sites in production/runtime code. (Test code is exempt — e.g. `electron/db/queries.test.ts` constructs an in-memory `Database` via the system-Node binding, since vitest runs in plain Node with no Electron ABI.)

## Build

```bash
npm run compile         # rebuilds dist-electron/ + dist-mcp/mcp-server.bundle.js
npm run type-check:all  # type-check renderer + electron (always run after changes)
```

esbuild is stricter than tsc — backticks inside template literals must be unescaped at the template level. Use `import * as z from "zod"` (not `import { z }`) in all Electron files.

**Never bump the project version.** The release scripts (`scripts/release.sh` for desktop, `scripts/releasemobile.sh` for mobile) bump the version and update the JSON automatically at release time — leave `package.json` / `mobile/app.json` untouched.

### Changelog rule (always keep the changelog ahead of the version)

Whenever you make a user-facing change, record it in a changelog **without being asked**. Always write to the changelog whose version is the next release *above the current package version* — never edit a changelog at or below the shipped version.

- **Desktop**: changelogs live in `changelogs/`; the current version is `version` in `package.json`.
- **Mobile**: changelogs live in `mobile/changelogs/`; the current version is `expo.version` in `mobile/app.json` (not `mobile/package.json`, which is stale).

Procedure for the relevant target (desktop and/or mobile):

1. Find the highest `changelogs/v*.md` file and compare its version to the current package version.
2. **If the latest changelog version is already `>` the current version**, append your entry to that existing file — it is the pending release. (e.g. version `2.4.6` + latest changelog `v2.4.7.md` → edit `v2.4.7.md`.)
3. **If no changelog is ahead of the current version** (the latest is `<=` the version), create a new file named for the next version above the current one — default to a patch bump (e.g. version `2.4.7`, latest changelog `v2.4.7.md` → create `v2.4.8.md`), unless the change clearly warrants a minor/major.

This guarantees `release.sh`'s gate (`changelogs/v<next>.md` must exist for the chosen bump) is satisfied, so the pending changelog and the version bump stay in lockstep — you never have to be told which changelog to touch.

### "What's New" modal rule (announce major features)

The What's New modal (`src/components/layout/NewFeatureModal.tsx`) is generated from a curated source, exactly like `licenses.json`:

- **Source of truth**: `scripts/features.config.js` (the `FEATURES` array). Hand-authored.
- **Generator**: `scripts/generate-features.js` → `src/generated/new-features.json` (git-ignored, baked into the static export). Runs in `build.js`, the `dev` script, and CI (next to `generate-licenses.js`).
- **Runtime**: `src/lib/new-features-registry.ts` reads the generated JSON — never edit the registry by hand.

**When you ship a MAJOR, user-facing feature, add an entry to `scripts/features.config.js`** (not every changelog line — only headline features worth announcing on launch; fixes and internal work stay in `changelogs/` only). Append at the end in release order with a stable, never-reused `id` (e.g. `v2.6.0-my-feature`), the release `version` (`vX.Y.Z`), a short `title`, a one-word-ish `category`, a `description`, and 3–4 `highlights` (a `"Prefix: rest"` highlight bolds the prefix). The modal auto-shows unseen entries belonging to the newest `version` present. Run `node scripts/generate-features.js` after editing; it validates the shape and rejects duplicate ids.

## Views and navigation

| View | Key | Component |
|------|-----|-----------|
| Overview | `⌘1` | `ProjectOverview` |
| Notes | `⌘2` | `NotesView` |
| Board | `⌘3` | `KanbanBoard` |
| Idea Flow | `⌘4` | `IdeaFlowView` |
| Knowledge Graph | `⌘5` | `KnowledgeGraphView` — Force + Radial only |
| Insights | `⌘6` | `InsightsView` — all analytics canvases |
| Settings | — | `SettingsView` |

`activeView` union: `"overview" | "notes" | "board" | "flow" | "graph" | "insights" | "chat" | "search" | "settings"`

## Knowledge Graph vs Insights split

**KnowledgeGraphView** (`src/components/graph/KnowledgeGraphView.tsx`) — Force-directed and Radial tree layouts only. Reads from `graphData` store slice (populated by `loadGraph()`). `GraphLayoutMode = "force" | "radial"`.

**InsightsView** (`src/components/insights/InsightsView.tsx`) — hosts all seven analytics canvases (which live in `src/components/graph/` alongside the KnowledgeGraph canvases and the shared scaffold). Also calls `loadGraph()` on mount (same as KGV) because canvases scope data via `useScopedData(nodes)` which needs `graphData.nodes` populated. Local `InsightsLayout` type — not stored in the global store.

## Analytics canvas architecture

All analytics canvases follow the same pattern:

```
InsightsView
  └── <XxxCanvas nodes={allNodes} ... />
        ├── useContainerDims(ref)     — ResizeObserver → { width, height }
        ├── useScopedData(nodes)      — derives activeProjects, scopedCards etc. from store
        ├── useFontScale()            — returns fontScale number for SVG fontSize scaling
        └── D3 / SVG rendering
```

Shared modules:
- `analyticsUtils.ts` — `PRIORITY_COLOR`, `CANVAS_PAD`, `truncateName`, `HOUR_MS`, `DAY_MS`, etc.
- `analyticsHooks.ts` — `useContainerDims`, `useScopedData`, `useFontScale`
- `AnalyticsShared.tsx` — `<CanvasEmptyState>`, `<CanvasTooltip>`, `<SvgTimeAxis>`
- `analyticsUtils.ts` — shared constants (`PRIORITY_COLOR`, `CANVAS_PAD`), `resolveCssVar()` for canvas 2D context colour lookups, `truncateName`

## Store slices

| Slice | File | Key exports |
|-------|------|-------------|
| UI | `slices/ui.ts` | `theme`, `setTheme`, `fontScale`, `setFontScale`, `activeView`, `setView`, `applyFontScale`, `applyTheme` |
| Workspace | `slices/workspace.ts` | `workspaces`, `projects`, `createProject`, `updateProject` |
| Board | `slices/board.ts` | `columns`, `cards`, `createCard`, `updateCard`, `moveCard` |
| Notes | `slices/notes.ts` | `notes`, `createNote`, `updateNote`, `deleteNote` |
| Tags | `slices/tags.ts` | `tags`, `createTag`, `updateTag` |
| Chat | `slices/chat.ts` | `threads`, `messages`, `sendMessage` |
| Graph | `slices/graph.ts` | `graphData`, `graphLoading`, `graphFilters`, `graphLayout`, `loadGraph`, `setGraphLayout`, `setGraphFilters` |
| Selectors | `slices/selectors.ts` | `getWorkspaceProjects`, `getProjectNotes`, `search` |

Hydration: `hydrate()` (web/localStorage) and `hydrateFromElectron()` both restore `theme` and `fontScale` from localStorage on startup.

## Font scale

```
FontScale = 1 | 1.1 | 1.2 | 1.3 | 1.4
DEFAULT_FONT_SCALE = 1.2  (M)
FONT_SCALE_KEY = "fontScale"  (localStorage key)
```

`applyFontScale(scale)` sets `document.documentElement.style.setProperty("--font-scale", scale)`. This overrides the CSS cascade `:root { --font-scale: 1 }` via inline style specificity.

## Data model (abbreviated)

```
Workspace
  └── Project
        ├── Note[]           (.md file + SQLite row)
        ├── Dashboard[]      (SQLite only, type="dashboard", content=HTML)
        ├── BoardColumn[]
        │     └── TaskCard[]
        ├── IdeaFlow
        │     ├── IdeaFlowNode[]
        │     └── IdeaFlowEdge[]
        └── ChatThread
              └── ChatMessage[]
```

Notes write to both `.md` files and SQLite simultaneously. Dashboards write to SQLite only (no `.md` file).

## Key constraints

- Never construct a `Database` instance outside `electron/db/client.ts` (Electron) and `mcp-server.ts` (MCP runtime) — those are the only two ABI bootstrap sites (see "better-sqlite3 ABI" above)
- All DB writes from renderer go through `ipc()` / `ipcAwait()` to the Electron main process
- `graphData` is lazy — only populated when `loadGraph(activeWorkspaceId)` is called. Both `KnowledgeGraphView` and `InsightsView` call it on mount.
- D3 `fontSize` in SVG must always be multiplied by `useFontScale()` — never hardcode px values

## Project Management

Use cairn mcp server to manage notes, tasks and idea flow nodes.  
When you find anything interesting create a note in the right project and add a card to the board (if needed).