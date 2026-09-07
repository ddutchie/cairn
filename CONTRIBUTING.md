# Contributing to Cairn

Thanks for your interest in contributing. Cairn is a local-first desktop app built with Electron + Next.js, and contributions of all kinds are welcome — bug fixes, new features, docs improvements, and test coverage.

This guide covers everything you need to go from zero to a working dev environment, understand the codebase, and submit a pull request.

---

## Table of contents

- [Getting started](#getting-started)
- [Project structure](#project-structure)
- [Architecture](#architecture)
  - [Views](#views)
  - [Process model](#process-model)
  - [Workspace folder](#workspace-folder)
  - [Storage split](#storage-split)
  - [Note file format](#note-file-format)
  - [Data model](#data-model)
  - [Dashboard rendering](#dashboard-rendering)
  - [Write paths](#write-paths)
  - [Font scaling](#font-scaling)
  - [Analytics canvas pattern](#analytics-canvas-pattern)
  - [Key files](#key-files)
- [Coding conventions](#coding-conventions)
- [Working on specific areas](#working-on-specific-areas)
  - [Working on the Agent workspace](#working-on-the-agent-workspace)
  - [Working on the Cairn Agent](#working-on-the-cairn-agent)
- [Tests](#tests)
- [Submitting a pull request](#submitting-a-pull-request)
- [Good first issues](#good-first-issues)

---

## Getting started

### Prerequisites

- **Node.js 22+** — check with `node --version` (esbuild targets Node 24; `@types/node` is v22)
- **macOS** — the dev workflow is macOS-first. Windows and Linux are untested but may work.
- **Python 3** — required by some native build tooling (usually pre-installed on macOS)
- **Xcode Command Line Tools** — `xcode-select --install` if you haven't already

### First-time setup

```bash
git clone https://github.com/ddutchie/cairn
cd cairn
npm install
npm run rebuild   # compiles better-sqlite3 native binaries for all three ABI targets
npm run compile   # bundles the Electron main process + MCP server
npm run dev       # starts Next.js + Electron together
```

> **Why `npm run rebuild`?** Cairn uses `better-sqlite3`, a native Node addon. It needs to be fanned out for three runtime contexts: the Electron ABI, the Node ABI used by the self-contained MCP binary, and the system Node ABI used by vitest (arch-separated arm64 + x64, re-signed on macOS — see AGENTS.md). `npm run rebuild` handles all three in the correct order. You need to re-run it if you update the Electron version.

The app opens automatically once Next.js is ready (usually ~10s on first run).

### Subsequent dev sessions

```bash
npm run dev
```

That's it — `compile:watch` runs in parallel and rebuilds the Electron main process on every `.ts` change. The renderer (Next.js) hot-reloads automatically.

### Useful commands

```bash
npm run type-check:all    # tsc --noEmit for renderer + electron — run this before every commit
npm test                  # full gate (licenses + features + compile + vitest) — run this before every commit
npm run test:watch        # watch mode
npm run test:e2e          # E2E smoke tests (headless Chromium) — run before any UI PR
npm run compile           # one-shot rebuild of dist-electron/ + dist-mcp/
npm run lint              # eslint (CI uses --max-warnings 0 — keep it clean)
```

### Getting help

Not sure where to start? Open a [GitHub Discussion](https://github.com/ddutchie/cairn/discussions) — ask questions, share ideas, or introduce yourself. For bugs use [GitHub Issues](https://github.com/ddutchie/cairn/issues).

> **Working with an AI coding agent?** Read [AGENTS.md](AGENTS.md) — it has architecture conventions and build commands tuned for LLM context windows (and is what powers the built-in Cairn agent).

---

## Project structure

<details>
<summary>View directory tree</summary>

```
cairn/
├── electron/               # Electron main process (Node.js, runs in Electron)
│   ├── main.ts             # Startup: BrowserWindow, IPC registration, file watcher
│   ├── preload.ts          # contextBridge: window.electron API exposed to renderer
│   ├── mcp-server.ts       # Standalone MCP binary entry point (imports queries.ts helpers)
│   ├── notes-files.ts      # Note file I/O: read/write/parse .md files
│   ├── file-watcher.ts     # chokidar watcher → SQLite sync on external .md edits
│   ├── workspace-config.ts # Read/write workspace-config.json
│   ├── db/
│   │   ├── client.ts       # ABI-isolated better-sqlite3 bootstrap
│   │   ├── schema.ts       # SQLite DDL + versioned migration runner
│   │   ├── queries.ts      # All typed SQLite query helpers
│   │   ├── graph-queries.ts# Knowledge Graph relationship queries
│   │   ├── defaults.ts     # DEFAULT_COLUMNS
│   │   └── utils.ts        # newId(), ts()
│   ├── ipc/
│   │   ├── handlers.ts     # Orchestrator — delegates to per-domain registrars below
│   │   ├── result-helpers.ts # handle(), ok(), err(), DbContext
│   │   ├── db-handlers.ts  # db:* CRUD channels (workspaces, projects, notes, cards, tags)
│   │   ├── flow-handlers.ts# db:flow:* channels (incl. AI summarizer BFS)
│   │   ├── ai-handlers.ts  # ai:* channels (generatePrd, localLLMStatus)
│   │   ├── llama-handlers.ts# llama:* channels (on-device LLM server)
│   │   ├── graph-handlers.ts# db:graph:* channels
│   │   ├── chat-db-handlers.ts# db:chat:* CRUD channels
│   │   ├── session-handlers.ts   # db:session:* channels
│   │   ├── pdf-export.ts   # app:exportNotePdf (uses lib/pdf-template.ts)
│   │   ├── url-metadata.ts # db:flow:url:fetch (uses lib/url-metadata.ts)
│   │   ├── mobile-handlers.ts# mobile:* channels
│   │   ├── migration-handlers.ts # app:*igration* channels
│   │   ├── settings-handlers.ts # app:{get,save}* settings channels
│   │   ├── agent.ts        # agent:* IPC channels — PTY spawn, file I/O, git diff
│   │   ├── chat.ts         # AI chat turn runner (Cordis) + compact-thread helper
│   │   ├── chat-session.ts # db:chat:sessionMessages replay reads (session-as-truth)
│   │   └── registry.ts     # registerIpcHandle/registerIpcOn, isWriteChannel whitelist
│   ├── lib/
│   │   ├── llm.ts          # callLLM, streamCompletion
│   │   ├── tools.ts        # TOOLS definitions, buildSystemPrompt
│   │   ├── context.ts      # buildContextResponse (get_cairn_context)
│   │   ├── read-tools.ts   # executeReadTool — shared by chat + dashboard bridge
│   │   └── ...
│   └── shared/
│       ├── db-mappers.ts   # Row→domain object mappers (toWorkspace, toProject, toNote, etc.)
│       ├── notes-io.ts     # Note file I/O helpers (shared across Electron + MCP)
│       ├── read-tools-pure.ts # executeSearchNotes, executeSearchTasks, executeGetProjectContextPack
│       └── text-utils.ts   # toSlug, stripMarkdown (no native deps — shared safely)
│
├── src/                    # Next.js renderer (React, runs in BrowserWindow)
│   ├── app/
│   │   ├── page.tsx        # Root shell: hydration, keyboard shortcuts, view switcher
│   │   └── globals.css     # Design tokens, base styles, font scaling
│   ├── store/
│   │   ├── index.ts        # Zustand store composition + hydration
│   │   └── slices/         # ui, workspace, board, notes, tags, chat, graph, selectors
│   ├── components/
│   │   ├── layout/         # Sidebar, topbar, project overview, app-chrome (UpdateBanner, ErrorToasts)
│   │   ├── kanban/         # Board, columns, cards, card detail
│   │   ├── notes/          # Note editor, dashboard view, markdown components
│   │   ├── flow/           # Idea Flow canvas + node components
│   │   ├── graph/          # Knowledge Graph + all analytics canvases + shared analytics modules
│   │   ├── insights/       # InsightsView (analytics hub)
│   │   ├── agent/          # Agent workspace (PTY + Cairn native agent): AgentChatPane, SessionBrowser, ContextRing, SpawnAgentModal, file tree, CM6 editor, xterm terminal, diff viewer
│   │   ├── chat/           # AI chat panel (chat-panel/index.tsx + sub-folder)
│   │   ├── search/         # Global search panel
│   │   ├── settings/       # Settings sections
│   │   ├── shared/         # Cross-feature shared components (e.g. CairnRefChip)
│   │   └── ui/             # Shared primitives: Button, Input, Dialog, Badge, ModalShell, etc.
│   ├── hooks/              # useChatStream, useLoadGraph, useIpcErrorToasts
│   ├── lib/                # constants, events, utils, storage, editor-theme (shared CM6 theme)
│   └── types/              # All shared TypeScript types (incl. PiAgentMessage, TerminalSession)
│
├── scripts/                # Build utilities (not bundled)
│   ├── rebuild-native.js   # Rebuilds better-sqlite3 for all three ABIs
│   ├── build.js            # electron-builder orchestration
│   ├── generate-licenses.js# Generates src/generated/licenses.json
│   └── ...
│
├── changelogs/             # One .md file per release
├── AGENTS.md               # Architecture guide for AI coding agents
└── README.md
```

</details>

---

## Architecture

<details>
<summary>Process model, storage, data model, write paths, key files</summary>

### Views

| View | Key | Level | Description |
|------|-----|-------|-------------|
| Overview | `⌘1` | Project | Project summary — metrics, pinned notes, recent activity |
| Notes | `⌘2` | Project | Split-pane markdown editor + dashboard renderer |
| Extra views | `⌘3`–`⌘9` | Mixed | Walk the visible views in sidebar order (default: Board, Calendar, Idea Flow, Agent, Calendar-all, Knowledge Graph, Insights, Automations, Usage). Hide views in General → Views to compress the range |
| Board | _(dynamic)_ | Project | Kanban with drag-and-drop |
| Idea Flow | _(dynamic)_ | Project | Freeform node canvas |
| Agent | _(dynamic)_ | Project | Coding agent workspace — Cairn native agent (chat UI) or external PTY agent (Claude Code, OpenCode, Aider); file tree, CM6 editor, xterm.js terminal, git diff viewer |
| Knowledge Graph | _(dynamic)_ | Workspace | Force-directed and Radial tree of notes/cards/tags (`GraphLayoutMode = "force" \| "radial"`) |
| Insights | _(dynamic)_ | Workspace | Analytics canvases: Ridgeline, Beeswarm, Bullet, Sankey, Timeline, Matrix, Table |
| Settings | — | App | General, AI (Chat / Coding Agents / MCP tabs), Extensions, Embeddings, Writing Style, Mobile Access, Device Sync, System |

### Process model

Cairn has two processes that share the same `cairn.db` (SQLite WAL mode):

**Renderer** (Next.js + React) — everything in `src/`. Never touches the filesystem or database directly. All data operations go through `window.electron.*` calls, defined in `electron/preload.ts` and handled in `electron/ipc/handlers.ts`.

**Main process** (Node.js) — everything in `electron/`. Owns the SQLite database, the filesystem, and the AI chat loop. Returns `{ data: T } | { error: string }` from every IPC handler.

**External agent workspace** (`electron/ipc/agent.ts`) — PTY sessions spawned via `node-pty` in the main process. File I/O is validated against registered `code_directory` paths before any read/write. Sessions are keyed by `sessionId`; PTY output is streamed to the renderer via `agent:data` IPC events. The renderer-side `TerminalManager` singleton holds `xterm.js` instances so they survive view navigation.

**Cairn coding agent** — a stateful multi-turn dsh/Cordis agent running entirely in the main process. No external binary required. Session type `"coding"` in the terminal sessions store; rendered by `AgentChatPane` instead of xterm. Key files:

- `electron/ipc/session-runtime-handlers.ts` — IPC handler; abort/persona lifecycle and `session:*` channels
- `electron/cordis/run-cordis-coding.ts` — mounts the dsh coding stack, creates/resumes agents, and bridges coding turns
- `electron/cordis/cairn-plugins.ts` — Cairn adapters for persistence, usage, questions, approvals, and renderer events
- `electron/cordis/cordis-coding-tools.ts` — dsh filesystem, search, shell, todo, sandbox, and instruction plugins
- `electron/lib/coding-session-prompt.ts` — stable Cairn coding-session context; plan guidance comes from dsh

The agent has access to a curated subset of Cairn's data tools (notes CRUD, task management, idea flow) through the dsh tool registry. `ensure_note` is the preferred write tool — idempotent by title, no duplicates. `AgentView` is always mounted (CSS-hidden when inactive) so agent refs and IPC subscriptions survive view switches.

**MCP server** (`electron/mcp-server.ts`) — a separate compiled binary that external AI agents connect to. Shares the same SQLite database and writes `.md` files directly; the Electron UI refreshes automatically via WAL mtime polling. The MCP tool files in `electron/mcp/tools/*` import query helpers from `electron/db/queries.ts` and `electron/db/graph-queries.ts` — these are the same helpers used by the Electron main process. The only ABI-sensitive operation is constructing the `Database` instance (once, in `mcp-server.ts` via `new Database(dbPath, { nativeBinding })`); after that, all `db.prepare(...).run(...)` calls work on that handle regardless of which TS file defines them.

External `.md` edits (e.g. the user editing a note in another editor) are picked up by a **chokidar file watcher** in the main process, which parses the frontmatter and upserts the SQLite row, then fires `db:changed` to the renderer.

### Workspace folder

On first launch Cairn asks the user to choose a **workspace folder** — any directory they control (Documents, iCloud Drive, a git repo, etc.). Everything Cairn owns lives inside it:

```
<workspace>/
  cairn.db          ← SQLite: projects, tasks, columns, chat (WAL mode)
  <Project Name>/
    <Note Title>.md   ← one file per note, YAML frontmatter + markdown body
```

The workspace path is stored in `<userData>/workspace-config.json` so it survives app updates.

### Storage split

| What | Where | Why |
|------|-------|-----|
| Notes content | `.md` files | Human-readable, portable, editable in any editor |
| Note metadata | YAML frontmatter in the same `.md` file | Keeps content and metadata together |
| Projects, tasks, columns, chat | `cairn.db` (SQLite) | Relational structure, fast queries, drag-and-drop ordering |
| SQLite search index for notes | `content_text` column in `notes` table | Keeps full-text search fast without parsing files |

Every note write (from the UI, AI chat, or MCP server) writes to **both** the `.md` file and SQLite simultaneously. The SQLite `notes` table is the read cache; the `.md` file is the source of truth for content.

### Note file format

```markdown
---
id: abc123def456
projectId: xyz789
workspaceId: ws001
title: My Note
tagIds: []
linkedNoteIds: []
linkedCardIds: []
isPinned: false
createdAt: 2025-01-01T00:00:00.000Z
updatedAt: 2025-01-01T00:00:00.000Z
---

Note body in plain markdown.
```

The `id` in the frontmatter is the stable identifier — **filenames are derived from the title** and can change when a note is renamed. The file watcher uses frontmatter `id` to match files to SQLite rows.

### Data model

```
Workspace
  └── Project
        ├── Note[]           (.md file + SQLite row, type = "note")
        ├── Dashboard[]      (SQLite row only, type = "dashboard" — HTML stored in content field)
        ├── BoardColumn[]    (SQLite only)
        │     └── TaskCard[] (SQLite only)
        ├── IdeaFlow         (SQLite only — one per project, auto-created)
        │     ├── IdeaFlowNode[]  (type: idea | note_ref | task_ref | group | url | ai_summary)
        │     └── IdeaFlowEdge[]
        └── ChatThread       (SQLite only)
              └── ChatMessage[]
```

Notes and task cards link bidirectionally via `linkedNoteIds` / `linkedCardIds`.

Dashboards are a specialisation of the `notes` table (`type = 'dashboard'`). Their `content` field holds a complete HTML document rather than markdown, so they are never written to `.md` files.

### Dashboard rendering

Dashboards render in a sandboxed `<iframe srcdoc>` inside the Notes panel. The iframe has no network access and no `allow-same-origin`. A lightweight postMessage bridge — `window.cairn.query(tool, args)` — lets dashboard JavaScript request live data from the main process:

```
Dashboard JS (iframe)
  │  window.cairn.query('list_tasks', { projectId })
  │  postMessage → cairn:query
  ▼
DashboardView (renderer)
  │  window.addEventListener('message') → electron.mcpQuery(tool, args)
  ▼
db:mcpQuery IPC (main process)
  │  runs read-only DB query via queries.ts helpers
  ▼
DashboardView
  │  postMessage → cairn:response { result }
  ▼
Dashboard JS
  └─ receives live data, updates DOM
```

Available query tools inside a dashboard: `get_cairn_context`, `get_project_summary`, `list_tasks`, `list_notes`, `list_recent_activity`, `search_tasks`, `search_notes`.

### Write paths

```
Note write (UI / chat / MCP)
  │
  ├── writeNoteFile()  → <workspace>/<Project>/<Title>.tmp → rename → .md  (atomic)
  └── SQLite upsert   → notes table (type='note', content_text re-derived from markdown,
                         version = version + 1)

Dashboard write (chat / MCP — create_dashboard / update_dashboard)
  │
  └── SQLite upsert   → notes table (type='dashboard', content = raw HTML)
                        (no .md file written — HTML is not markdown)

External .md edit (live)
  │
  └── chokidar watcher → parseNoteFile() → upsertNoteFromFile() → SQLite
                                                                 → db:changed → renderer refresh

External .md edit (startup — Cairn was closed)
  │
  └── syncNotesFromDisk() → compare frontmatter updatedAt / file mtime vs DB updated_at
                           → if file is newer: upsertNoteFromFile() → SQLite
```

**AI edit lock.** While the AI writes to a note the editor enters read-only mode:

- **In-process (chat executor)** — `electron/lib/ai-write-lock.ts` holds a module-level `Set<string>`. The 5 note-writing cases in `chat-executor.ts` call `lockNote` / `unlockNote` in a try/finally. The lock fires `note:aiWriteStarted` / `note:aiWriteEnded` directly to the renderer via `webContents.send`.
- **Cross-process (MCP server)** — `mcp_active_writes` SQLite table (migration v11). MCP tools INSERT on start, DELETE on finish. The WAL poller diffs the table each tick and fires the same IPC events.

The renderer's `note-editor.tsx` subscribes to both events and flips the CM6 editor into `readOnly` mode via a `Compartment` — no editor recreation, undo history preserved.

**Optimistic concurrency.** Both `notes` and `task_cards` carry a `version INTEGER` (migrations v12/v13) that increments on every write. MCP tools that mutate notes or tasks accept an optional `expectedVersion` argument and return a conflict error if the row version has advanced since the caller last read it. `get_note` and `get_task` both return the current `version`.

### Font scaling

`--font-scale` is a CSS custom property set inline on `<html>` by `applyFontScale()`. Root `font-size: calc(14px * var(--font-scale))` drives all `rem`-based Tailwind classes proportionally. The preference is persisted to `localStorage` under the key `fontScale`. SVG canvas `fontSize` attributes must be multiplied by `useFontScale()` from `src/components/graph/analyticsHooks.ts`.

**Rule:** never use `text-[Npx]` Tailwind classes — use `rem` equivalents (`text-[0.714rem]`, `text-[0.786rem]`, etc.) so text scales with the font size setting.

### Analytics canvas pattern

All analytics canvases share a common pattern:

```
InsightsView
  └── <XxxCanvas nodes={allNodes} />
        ├── useContainerDims(ref)   — ResizeObserver → { width, height }
        ├── useScopedData(nodes)    — derives activeProjects, scopedCards from store
        ├── useFontScale()          — returns fontScale multiplier for SVG fontSize
        └── D3 / SVG rendering
```

Shared modules live in `src/components/graph/`: `analyticsUtils.ts` (constants, `PRIORITY_COLOR`, `resolveCssVar`, `truncateName`, `CANVAS_PAD`), `analyticsHooks.ts` (`useContainerDims`, `useScopedData`, `useFontScale`, `useRelativePointer`, `useNow`), `AnalyticsShared.tsx` (`<CanvasEmptyState>`, `<CanvasTooltip>`, `<SvgTimeAxis>`).

### Key files

**Electron main process**

| File | Purpose |
|------|---------|
| `electron/main.ts` | Startup orchestrator — BrowserWindow, IPC registration, file watcher |
| `electron/migrations.ts` | Workspace migration registry, runner, and layout upgrade schemas |
| `electron/lib/protocol.ts` | `app://` scheme registration + CSP headers |
| `electron/lib/tray.ts` | System tray icon, menu, and badge update logic |
| `electron/lib/ai-write-lock.ts` | Module-level `Set<string>` tracking active in-process AI note writes; fires `note:aiWriteStarted/Ended` IPC |
| `electron/lib/mcp-poller.ts` | WAL mtime polling → `db:changed` IPC + MCP notification dispatch + `mcp_active_writes` diff for cross-process AI lock events |
| `electron/lib/read-tools.ts` | `executeReadTool(db, snap, tool, args)` — shared read dispatch used by chat and dashboard bridge |
| `electron/workspace-config.ts` | Read/write `workspace-config.json`; resolve `cairn.db` path |
| `electron/notes-files.ts` | Note file I/O: `writeNoteFile` (atomic `.tmp` → rename), `deleteNoteFile`, `parseNoteFile`, `upsertNoteFromFile`, `syncNotesFromDisk` (startup timestamp compare), `cleanStaleTmpFiles` |
| `electron/file-watcher.ts` | chokidar watcher on workspace root; syncs external `.md` edits to SQLite |
| `electron/ipc/handlers.ts` | Orchestrator — calls per-domain registrars (`db-handlers`, `flow-handlers`, `ai-handlers`, `llama-handlers`, `graph-handlers`, `chat-db-handlers`, `session-handlers`, `pdf-export`, `url-metadata`, `mobile-handlers`, `migration-handlers`, `settings-handlers`); all wrapped in `handle()` returning `IpcResult<T>` |
| `electron/ipc/agent.ts` | All `agent:*` IPC channels — PTY spawn/kill, file I/O, git diff, `assertWithinCodeDirectory` |
| `electron/ipc/chat.ts` | AI chat IPC handler and Cordis chat-loop adapter |
| `electron/cordis/chat-executor.ts` | `executeTool` — all AI tool implementations |
| `electron/ipc/session-runtime-handlers.ts` | Coding-session IPC adapter — abort/persona lifecycle and `session:*` channels |
| `electron/cordis/run-cordis-loop.ts` | Shared Cordis context, plugin composition, chat agent lifecycle, and session replay helpers |
| `electron/cordis/run-cordis-coding.ts` | Coding-agent lifecycle, dsh stack mounting, and live-turn bridge |
| `electron/cordis/cairn-plugins.ts` | Cairn persistence, usage, questions, approval, and renderer-event adapters |
| `electron/cordis/cordis-coding-tools.ts` | dsh sandbox, filesystem, search, shell, todo, and instruction plugins |
| `electron/lib/coding-session-prompt.ts` | Stable Cairn coding-session context; plan guidance comes from dsh |
| `electron/lib/truncation.ts` | `truncateOutput(text, opts)` — unified byte+line cap for all coding tool outputs; exports `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, `TruncationResult` |
| `electron/cordis/plugins/` | Cairn-owned Cordis plugins, including workspace context and context-ring projections |
| `electron/lib/llm.ts` | `LLMConfig`, `callLLM`, `streamCompletion`, `isLocalEndpoint`, `normaliseBaseUrl` |
| `electron/lib/tools.ts` | `TOOLS` (OpenAI function definitions), `TOOL_LABELS`, `buildSystemPrompt` |
| `electron/cordis/chat-executor.ts` | `executeTool` — canonical tool implementations (incl. `get_cairn_context`) |
| `electron/lib/prd.ts` | `generatePrd` — shared PRD generation logic |
| `electron/db/queries.ts` | Single source of truth for all SQL query helpers (CRUD, search, snapshot, `getProjectById`, `getNoteById`, `getCardById`). Imported by both the Electron main process and the MCP server (`electron/mcp/tools/*`) — the only ABI-sensitive operation is `new Database(...)` which happens once in `mcp-server.ts` |
| `electron/shared/text-utils.ts` | Pure text helpers shared across the process boundary: `toSlug`, `stripMarkdown` |
| `electron/db/schema.ts` | SQLite DDL + versioned migration runner (`PRAGMA user_version`) |
| `electron/db/utils.ts` | `newId()` (nanoid), `ts()` — shared ID and timestamp helpers |
| `electron/db/defaults.ts` | `DEFAULT_COLUMNS` — canonical 5-column board layout |
| `electron/mcp-server.ts` | Standalone MCP binary entry point; imports query helpers from `db/queries.ts` (same code as the Electron main process) |

**Renderer**

| File | Purpose |
|------|---------|
| `src/store/index.ts` | Zustand store composition + hydration; delegates to domain slices |
| `src/store/slices/` | Domain slices: `ui` (theme, fontScale, activeView), `workspace`, `board`, `notes`, `tags`, `chat`, `graph`, `selectors`, `coding-agents`, `terminal-sessions` |
| `src/store/ipc.ts` | Shared `isElectron`, `ipc`, `ipcAwait` helpers; `markOwnNoteWrite` / `isOwnNoteWrite` per-note write map (1.5 s window) used to gate WAL-poller re-hydration |
| `src/hooks/useChatStream.ts` | AI stream lifecycle hook — subscriptions, loading state, `sendStream` |
| `src/lib/constants.ts` | Shared constants: `COLUMN_COLORS`, `PRIORITY_OPTIONS`, `DEFAULT_AI_CONFIG`, etc. |
| `src/lib/events.ts` | Typed `CairnEvents` helpers for internal custom event dispatch |
| `src/types/index.ts` | All shared types: `IpcResult<T>`, `ProjectSummaryResult`, `DashboardQueryMessage`, etc. |
| `src/components/onboarding/create-workspace.tsx` | First-launch folder picker + workspace creation |
| `src/components/layout/MigrationModal.tsx` | Glassmorphism modal blocking interactions and showing progress during workspace migration |
| `src/components/notes/note-editor.tsx` | Split-pane markdown editor + AI text toolbar |
| `src/components/notes/dashboard-view.tsx` | Sandboxed iframe renderer; `window.cairn` postMessage bridge |
| `src/components/notes/dashboard-bootstrap.ts` | Dashboard bootstrap JS builder (`buildBootstrap`, `buildSrcdoc`) |
| `src/components/layout/project-overview/useProjectMetrics.ts` | Derived metrics hook (due dates, priority counts, activity grouping) |
| `src/components/settings/settings-view.tsx` | Settings shell; section components in `settings/` directory |
| `src/components/flow/flow-view.tsx` | Idea Flow canvas — `@xyflow/react` v12, DB sync, suppress-reload mechanism |
| `src/components/flow/NodeEditModal.tsx` | Type-aware node edit form with live note/task search pickers |
| `src/components/flow/nodes/` | Six custom node components (IdeaNode, NoteRefNode, TaskRefNode, GroupNode, UrlNode, AiSummaryNode) |
| `src/components/flow/edges/FlowEdge.tsx` | Custom bezier edge with hover-delete button via EdgeLabelRenderer |
| `src/components/graph/KnowledgeGraphView.tsx` | Graph view — Force-directed and Radial layouts only |
| `src/components/graph/ForceGraphCanvas.tsx` | Force-directed canvas via raw D3 (`d3-force` + canvas 2D); project-cluster convex hulls |
| `src/components/graph/RadialTreeCanvas.tsx` | Radial hierarchy tree via D3 |
| `src/components/graph/analyticsUtils.ts` | Shared constants + pure helpers: `PRIORITY_COLOR`, `PRIORITY_WEIGHT`, `PRIORITY_SORT_ORDER`, `resolveCssVar()`, `truncateName()`, `CANVAS_PAD` |
| `src/components/agent/AgentView.tsx` | Three-pane layout — drag-resize dividers, Editor/Diff tab bar; always mounted (CSS-hidden when inactive) |
| `src/components/agent/SessionPane.tsx` | Session content shell — selected Chat/Coding/PTY view, session creation, and panel actions |
| `src/components/agent/SessionBrowser.tsx` | Project-scoped Conversations browser — Chat/Coding/PTY session selection and search |
| `src/components/agent/AgentChatPane.tsx` | Cairn native coding-agent UI — Cordis IPC subscriptions, prompt lifecycle, context ring |
| `src/components/agent/AgentMessageBubble.tsx` | Coding-agent message renderer — user/assistant/error bubbles, tool calls, Cairn references, and subagent blocks |
| `src/components/agent/ContextRing.tsx` | Reusable SVG context usage ring; `size` and `stroke` props; colour shifts at 65 % and 85 % |
| `src/components/agent/AgentEditor.tsx` | Multi-file tabbed editor — tab management, preview toggle, save |
| `src/components/agent/FileEditorInner.tsx` | Single CM6 editor instance per file — CSS-hidden when inactive |
| `src/components/agent/DiffViewer.tsx` | Git diff polling, toolbar, collapsible files, view mode toggle |
| `src/components/agent/DiffFile.tsx` | Diff sub-components — palette, syntax HL, UnifiedFile, SplitFile, FileDiff |
| `src/components/agent/FileTree.tsx` | Lazy-expanding directory tree; direct `pickDirectory` → `updateProject` |
| `src/components/agent/TerminalManager.ts` | Module-scope singleton — holds xterm Terminal + FitAddon per session |
| `src/components/agent/SpawnAgentModal.tsx` | Spawn dialog — optional card, ad-hoc sessions, prompt editor |
| `src/lib/editor-theme.ts` | Shared CM6 `buildTheme(fontScale)` + `buildHighlightStyle(isDark)` + `buildSearchTheme()` — search panel CSS overrides used by both the note editor and agent file editor |
| `src/components/agent/ImageViewer.tsx` | Image renderer via base64 IPC (avoids `file://` CSP restriction) |
| `src/components/insights/InsightsView.tsx` | Insights view — hosts all analytics canvases with shared toolbar |
| `src/components/graph/analyticsUtils.ts` | Shared constants + pure helpers for analytics canvases |
| `src/components/graph/analyticsHooks.ts` | `useContainerDims`, `useScopedData`, `useFontScale`, `useRelativePointer`, `useNow` |
| `src/components/graph/AnalyticsShared.tsx` | `<CanvasEmptyState>`, `<CanvasTooltip>`, `<SvgTimeAxis>` |
| `src/components/graph/RidgelineCanvas.tsx` | Ridgeline (joy plot) activity canvas |
| `src/components/graph/BeeswarmCanvas.tsx` | Beeswarm time-axis canvas |
| `src/components/graph/BulletCanvas.tsx` | Bullet chart project health canvas |
| `src/components/graph/SankeyCanvas.tsx` | Sankey pipeline flow canvas |
| `src/components/graph/TimelineCanvas.tsx` | Timeline (cards by due date) canvas |
| `src/components/graph/MatrixCanvas.tsx` | Tag co-occurrence matrix canvas |
| `src/components/graph/TableCanvas.tsx` | Flat sortable table canvas |

</details>

---

## Coding conventions

### TypeScript

- Run `npm run type-check:all` before every commit. This checks both the renderer (`tsc --noEmit`) and the Electron main process (`tsc --noEmit -p tsconfig.electron.json`). PRs with type errors will not be merged.
- Avoid `any` — use specific types or `unknown` with a type guard.
- All IPC handlers return `IpcResult<T>` (`{ data: T } | { error: string }`). Check `isIpcError()` on the receiving end.

### Styling

- **All colours must use CSS variables** — `var(--background)`, `var(--accent)`, `var(--text-primary)`, etc. Never use raw Tailwind colour names (`text-gray-500`, `bg-blue-600`).
- **Alpha variants** — use `color-mix(in srgb, var(--token) X%, transparent)`. Never hardcode `rgba()`.
- **Font sizes** — use `rem`-based Tailwind classes (`text-xs`, `text-sm`, `text-[0.714rem]`). **Never use `text-[Npx]`** — pixel classes don't scale with the user's font size preference.
- **SVG font sizes** — multiply by `useFontScale()` from `analyticsHooks.ts`. Never hardcode a number directly as a `fontSize` SVG attribute.
- When in doubt, check `src/app/globals.css` for the full token list.

### State management

- All state lives in Zustand slices under `src/store/slices/`. Add new domain state there.
- Components read from the store via `useCairnStore()`. Never call `window.electron.*` directly from a component — go through a store action.
- The `graph` slice is lazy — `graphData` is only populated when `loadGraph()` is called. Both `KnowledgeGraphView` and `InsightsView` call it on mount.

**Performance: use narrow selectors, not full-store subscriptions.**

Calling `useCairnStore()` with no selector subscribes to the entire store — every write anywhere re-renders the component. Always select only the fields you need:

```ts
// Avoid — subscribes to the entire store
const { cards, columns } = useCairnStore();

// Prefer — only re-renders when cards or columns change
import { useShallow } from 'zustand/react/shallow';
const { cards, columns } = useCairnStore(
  useShallow((s) => ({ cards: s.cards, columns: s.columns }))
);

// For a single value, no useShallow needed
const fontScale = useCairnStore((s) => s.fontScale);
```

Use `React.memo` on list-item components (`KanbanCard`, `NoteListItem`, `ProjectItem`, etc.) so their memoisation is meaningful once selectors are in place. Wrap expensive derivations in `useMemo` — `buildFolderTree`, `getWorkspaceProjects`, tag lookups — so they only recompute when their inputs change, not on every store write.

### IPC boundary

- Renderer → main: use `ipc()` (fire-and-forget) or `ipcAwait()` (returns `IpcResult<T>`) from `src/store/ipc.ts`.
- New IPC channels go in the appropriate per-domain registrar in `electron/ipc/` (e.g. `db-handlers.ts` for `db:*`, `flow-handlers.ts` for `db:flow:*`, etc.), wrapped in the `handle()` helper from `result-helpers.ts`. `handlers.ts` is the orchestrator — add a `registerXxxHandlers(ctx)` call there if creating a new registrar.
- `electron/db/queries.ts` is the **single source of truth for all SQL**. Both the Electron main process and the MCP server (`electron/mcp/tools/*`) import from it. The only ABI-sensitive operation is constructing the `Database` instance — that happens once in `electron/mcp-server.ts` (`new Database(dbPath, { nativeBinding: MCP_NATIVE_BINDING })`). Never construct a `Database` instance outside `electron/db/client.ts` (Electron) and `mcp-server.ts` (MCP runtime).
- Use `import * as z from "zod"` (not `import { z }`) in all Electron/MCP files — esbuild quirk.
- When calling `ipc()` or `ipcAwait()` for a note mutation, also call `markOwnNoteWrite(noteId)` from `src/store/ipc.ts` immediately before — this tells the WAL poller re-hydration path to preserve the in-memory optimistic state for that note rather than overwriting it from the DB snapshot.

### Database migrations

- Schema changes go in `electron/db/schema.ts` as a new numbered entry in the `MIGRATIONS` array.
- **Never edit existing migrations** — they've already run on users' databases. Only append.
- Track the version with `PRAGMA user_version`.

### Analytics canvases

All canvases in `src/components/graph/` follow a shared pattern:

```
export function XxxCanvas({ nodes, onNodeClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fs           = useFontScale();           // for SVG fontSize
  const dims         = useContainerDims(containerRef);
  const { activeProjects, scopedCards, ... } = useScopedData(nodes);
  // D3 / SVG rendering ...
}
```

Use `CanvasEmptyState`, `CanvasTooltip`, and `SvgTimeAxis` from `AnalyticsShared.tsx` rather than reinventing them.

---

## Working on specific areas

<details>
<summary>Adding views, Agent workspace internals, analytics canvases, MCP tools, DB tables</summary>

### Adding a new view

1. Add the view key to the `activeView` union in `src/types/index.ts`
2. Add a keyboard shortcut in `src/app/page.tsx`
3. Add a sidebar button in `src/components/layout/sidebar.tsx` (both collapsed and expanded variants)
4. Wire the component render in `src/app/page.tsx`

### Working on the Agent workspace

The Agent workspace has its own IPC namespace (`agent:*`) entirely separate from the main `db:*` handlers:

- **PTY sessions** — spawned in `electron/ipc/agent.ts` via `node-pty`. `node-pty` must be `--external` in esbuild and rebuilt for the Electron ABI via `npm run rebuild`. PTY output streams to the renderer via `ipcMain.emit('agent:data', ...)`.
- **File I/O security** — every `readFile`, `readDir`, `writeFile`, and `readFileBase64` call goes through `assertWithinCodeDirectory(db, path)` before touching the filesystem. This validates the path against all registered `code_directory` values in the `projects` table. Never skip this check when adding new file IPC handlers.
- **Renderer terminal** — `TerminalManager` (module-scope singleton) holds `xterm.js` Terminal + FitAddon instances. Sessions survive view navigation because the singleton is never garbage-collected. Font size updates must set `terminal.options.fontSize` and call `fitAddon.fit()` via `requestAnimationFrame` (one frame needed for cell remeasure).
- **CM6 editor** — one `EditorView` instance per open file, CSS-hidden when inactive. `buildTheme(fontScale)` in `lib/editor-theme.ts` accepts `fontScale` so the editor respects the user's font size setting. CM6 `HighlightStyle.define` requires static colour strings — CSS variables cannot be used there (documented in `editor-theme.ts`). The editor includes a find/replace panel via `@codemirror/search` (`⌘F`); `buildSearchTheme()` must be appended **after** `buildTheme()` in the extensions array to override CM6's default `.cm-button`/`.cm-textfield` gradient styles with Cairn CSS variables.
- **File search** — `agent:searchFiles` IPC (registered in `electron/ipc/agent.ts`) recursively walks the `code_directory` for filename matches, triggered by `⌘⇧F` in `FileTree.tsx` via a capture-phase listener that fires before the global `page.tsx` handler. Subject to the same `assertWithinCodeDirectory` security check as all file operations. Returns up to 50 results; skips `node_modules`, `.git`, `.next`, `dist*`, and similar build directories.
- **`code_directory`** — stored on the `projects` table (migration v10). Set from the Project Overview inline row, not from AgentSettings. Written via the generic `db:project:update` IPC channel.

### Working on the Cairn Agent

The Cairn coding agent (`sessionType: "coding"`) runs in the Electron main process. Its IPC namespace is `session:*`, entirely separate from `agent:*` (PTY) and `db:*` (data).

**Adding a new coding tool**

1. Register it through the appropriate dsh/Cordis tool plugin or in `electron/cordis/cairn-tools.ts`.
2. Mount the plugin in the Cordis composition if it is not already part of the coding stack.
3. Add presentation metadata or a renderer tool view only when the result needs a specialized display.
4. Add the tool to the shared risk classification if its approval behavior differs from the default.

**Adding a new Cairn data tool to the agent**

The coding agent exposes Cairn tools through the dsh tool registry. To expose a new tool:

1. Register the tool with `registerCairnTools()` in `electron/cordis/cairn-tools.ts`.
2. Update the relevant dsh/Cairn system-prompt section if the tool warrants explicit mention.
3. If it returns a Cairn reference, provide the appropriate `presentationMeta` so replayed results remain linkable.
4. Add it to the shared approval-risk classification when needed.

**IPC event flow for a single agent turn**

The dsh engine runs the model↔tool loop internally — Cairn only translates
what it emits. The renderer gets two streams (see `runSession` in
`electron/ipc/session-runtime-handlers.ts` and `cairnCodingPlugin` in
`electron/cordis/cairn-plugins.ts`):

```
renderer                         main process
   │                                  │
   ├─ session:prompt ───────────────► runCordisCodingLoop()
   │                                  │  dsh agent loop runs model↔tool steps
   │ ◄── session:event ───────────────┤  raw DSH events (no flattening)
   │ ◄── session:projection ──────────┤  typed UI updates: token, thought,
   │                                  │  tool-call, tool-done, todos, usage,
   │                                  │  retry, compact, plan-note, mode-change
   ├─ session:abort ───────────────► agent.cancel({ kind: "user" })
   ├─ session:respond-tool ────────► pending approval resolver
   ├─ session:respond-questions ───► pending question resolver
   ├─ session:approve-plan ────────► execute mode with PRD context
```

Live token/thought deltas stream via `session:event`; chips, todos, usage,
and status lines arrive as `session:projection`. The session log (JSONL) is
the source of truth for interrupted prefixes and reloads.

**Parallel tool execution** — dsh owns tool scheduling and session event ordering. Cairn tools must be safe to execute through the dsh tool registry; per-domain persistence and file guards remain in their respective adapters.

**Automatic retry** — dsh's retry plugin handles transient provider failures on the request-recovery seam. Cairn forwards the resulting retry events to the renderer; do not add a second retry loop in an IPC handler.

**Context compaction** — dsh's compaction plugin owns automatic and manual compaction. Cairn only supplies the model adapter and forwards compaction lifecycle events to the renderer.

**`/compact` slash command** — the command registry routes `/compact` to the dsh compaction service. Keep command handling in the registry rather than adding another prompt-specific IPC implementation.

**Cancellation** — call the live dsh agent's `cancel({ kind: "user" })`; aborting a Cairn wrapper controller alone is insufficient. The session log remains the source of truth for the interrupted prefix.

**Output limits** — use the limits and retention behavior supplied by dsh tool plugins. Cairn adapters should not introduce a second formatting or truncation contract.

**Subagents**

`subagent` (one-shot) and `delegate` (continuable) are supplied by the dsh subagent stack. Cairn's bridge forwards child events through the shared subagent channel and keeps parent and child session state separate.

**Plan Mode**

Launch with `mode: "plan"` to begin a dsh-native planning session. Plan mode is logged by dsh as `plan/mode`, adds the configured plan policy, and keeps the stable `exit_plan_mode` tool available. The renderer presents the plan-review card supplied by dsh; approval unblocks the current tool call and dsh applies the exit at the next step boundary. Cairn's base system prompt remains unchanged between modes. Implemented in `@deepseek-ai/dsh-plan-mode`, `electron/cordis/run-cordis-coding.ts`, and `src/components/conversation/QuestionForm.tsx`.

**System prompt**

`buildExecuteModePrompt()` in `coding-session-prompt.ts` provides the stable Cairn coding-session context, including the project name, `cwd`, active task title, date, and (when available) the approved plan for execution. Plan-mode behavior belongs to dsh's configured `plan:policy` section, not to a second Cairn system-prompt variant.

### Adding a new analytics canvas

1. Create `src/components/graph/XxxCanvas.tsx` following the pattern above
2. Add it to `InsightsView.tsx` — toolbar entry in `LAYOUTS` and a canvas render block
3. If it has unique toolbar controls (zoom, mode toggle etc.), lift that state into `InsightsView`

### Adding a new MCP / AI chat tool

1. Add the Zod schema to `electron/lib/tool-schemas.ts` — `TOOL_SCHEMAS`, and `CHAT_ONLY_TOOLS` if it should be agent/chat only
2. Add a human-readable `TOOL_LABELS` entry in `electron/lib/tools.ts` (the `TOOLS` array is auto-derived from `TOOL_SCHEMAS`)
3. Add the executor case to `electron/cordis/chat-executor.ts`
4. Add the MCP executor case to `electron/mcp/tools/` (the appropriate tool file: `notes.ts`, `tasks.ts`, `flow.ts`, etc. — delegate to `q.*` helpers from `db/queries.ts`)
5. Add a corresponding query helper to `electron/db/queries.ts` if needed

> **Consolidation pattern:** prefer extending an existing tool over adding a new one. `update_task` handles archive/restore (`archived: true/false`) and block/unblock (`blockedBy`/`unblockFrom`) in addition to field updates. `upsert_project` handles both create (no `projectId`) and update (with `projectId`). Follow the same pattern to keep the tool surface small.

### Adding a new database table

1. Add a migration to `electron/db/schema.ts` (new entry in `MIGRATIONS`, increment `SCHEMA_VERSION`)
2. Add typed query helpers to `electron/db/queries.ts`
3. Add IPC handlers to the appropriate per-domain registrar in `electron/ipc/` (e.g. `db-handlers.ts` for `db:*`)
4. Expose via `window.electron.*` in `electron/preload.ts`
5. Add corresponding store slice actions in `src/store/slices/`

</details>

---

## Tests

Tests live next to the code they cover, under both `electron/` (store/lib/MCP logic) and `src/` (store slices, pure libs, and React components):

```bash
npm test                  # full gate: licenses + features + compile + all unit tests
npm run test:watch        # watch mode — great for TDD
npm run test:coverage    # coverage report
npm run test:unit        # node project only (store/lib/electron logic)
npm run test:component   # component project only (React + jsdom)
```

vitest runs **three projects** (see `vitest.config.ts`):

- **`node`** — the default fast suite for store slices, pure libs, and the
  electron/MCP layer. Runs in the `node` environment with the native SQLite
  shim. Matches `electron/**/*.test.ts`, `src/**/*.test.ts`, and
  `src/**/*.test.tsx`, excluding component tests (`src/**/*.component.test.tsx`).
- **`component`** — React component tests rendered in **jsdom** via
  `@testing-library/react`. Matches `src/**/*.component.test.tsx` and loads
  `vitest.setup.components.ts` (jest-dom matchers + auto-cleanup). Use these for
  presentational behavior (disabled states, ARIA attributes, click handlers).
  Store-connected components can mock `@/store` with `vi.mock`.
- **`mobile`** — the mobile app's standalone suite (`mobile/**/*.test.ts`,
  separate tsconfig).

| Test file | What it covers |
|-----------|---------------|
| `electron/db/queries.test.ts` | SQLite query helpers — CRUD, search, soft-delete |
| `electron/notes-files.test.ts` | File I/O, slug generation, frontmatter round-trip, atomic writes, startup sync |
| `electron/mcp-server.test.ts` | All MCP tools end-to-end via in-memory SQLite — happy path, edge cases, conflict detection |
| `electron/ipc/chat-executor.test.ts` | Every tool case in `executeTool` |
| `electron/ipc/handlers.test.ts` | IPC data layer, `executeReadTool`, `buildContextResponse` |
| `electron/cordis/*.test.ts` | Cordis session, plan-mode, approval, persistence, and runtime integration tests |

**Live integration tests** — Cordis live tests are gated by their documented environment variables and are automatically skipped when the required endpoint or key is absent.

**Please add or update tests when:**
- Adding a new query helper to `queries.ts`
- Adding a new tool to `electron/cordis/cairn-tools.ts` or a Cordis tool plugin
- Fixing a bug — a test that would have caught it prevents regression

vitest uses a SQLite shim (`vitest-sqlite-shim.cjs`) to ensure the system Node ABI binary is used instead of the Electron-compiled one. This is handled automatically — you don't need to think about it.

---

## Submitting a pull request

1. **Fork** the repo and create a branch from `main`: `git checkout -b your-name/feature-description`
2. **Make your changes** — follow the conventions above
3. **Type-check**: `npm run type-check:all` — must pass with zero errors
4. **Tests**: `npm test` — must pass
5. **Commit** with a clear message describing *what* and *why*
6. **Open a PR** against `main` with:
   - A short description of what changed and why
   - Screenshots or a short screen recording for any UI changes
   - A note on anything you're unsure about or would like feedback on

### PR checklist

- [ ] `npm run type-check:all` passes with zero errors
- [ ] `npm test` passes
- [ ] `npm run test:e2e` passes (required for UI changes or release PRs)
- [ ] No raw colour values — CSS variables only (`var(--accent)`, `var(--text-primary)`, etc.)
- [ ] No `text-[Npx]` pixel font classes — rem equivalents only (`text-[0.714rem]`, `text-xs`, etc.)
- [ ] New IPC handlers wrapped in `handle()` and return `IpcResult<T>`
- [ ] New DB migrations appended (not edited) in `schema.ts`
- [ ] New SQL goes in `electron/db/queries.ts` — the single source of truth (imported by both Electron main process and MCP server)
- [ ] Screenshots or recording included for any UI changes
- [ ] `useCairnStore()` calls use narrow selectors (not full-store subscriptions)
- [ ] If subscribing to store functions (e.g. `getColumnCards`) ensure raw data (e.g. `cards`) is also in the selector so mutations trigger re-renders
- [ ] List-item components wrapped in `React.memo`
- [ ] Expensive derivations wrapped in `useMemo` (not recomputed every render)
- [ ] IPC-driven state updates that must paint before the next IPC message arrives use `flushSync` to bypass React 18 automatic batching

---

## Good first issues

If you're new to the codebase, these are good places to start. Each one is self-contained, won't conflict with ongoing work, and has clear acceptance criteria.

### 🟢 No TypeScript required

- **Accessibility audit** — check components for missing ARIA labels (`aria-label`, `role`), keyboard navigation gaps, or colour contrast issues. Focus on the Kanban board and the Settings panel first.
- **Docs improvements** — the [cairn-site](https://github.com/ddutchie/cairn-site) docs always lag behind new features. Pure HTML/CSS — no build step.
- **Improve the `Good first issues` list** — if you find something genuinely approachable that isn't listed here, add it and open a PR.

### 🟡 TypeScript / React

- **Zustand selector narrowing** — replace bare `useCairnStore()` calls (which subscribe to the *entire* store) with narrow `useShallow` selectors. Good candidates with real impact: `MCPSettings`, `GeneralSettings`, `InsightsView`. Each component is a single self-contained file.
  ```ts
  // Before — re-renders on every store write
  const { cards, columns } = useCairnStore();
  // After — only re-renders when these two fields change
  const { cards, columns } = useCairnStore(useShallow((s) => ({ cards: s.cards, columns: s.columns })));
  ```
- **`React.memo` on `ProjectItem`** — `KanbanCard` and `NoteListItem` are already wrapped; `ProjectItem` (`src/components/layout/sidebar.tsx`) is the remaining high-value candidate. Wrap it after narrowing its store subscriptions.
- **Test coverage for a utility function** — `electron/shared/text-utils.ts` (`toSlug`, `stripMarkdown`) and `electron/db/utils.ts` (`newId`, `ts`) have no dedicated tests. Add them to the nearest test file.

### 🔴 Electron / SQLite

- **New MCP tool** — pick a missing read-only query (e.g. `list_dashboards`) and add it end-to-end following the 6-step checklist in [Adding a new MCP / AI chat tool](#adding-a-new-mcp--ai-chat-tool).
- **Bug fixes** — check the [open issues](https://github.com/ddutchie/cairn/issues) labelled `good first issue` for the current list.

> **Tip:** if you're unsure which file to touch, drop a question in [Discussions](https://github.com/ddutchie/cairn/discussions) or leave a comment on the issue before writing code.

---

## Questions

Open a [GitHub Discussion](https://github.com/ddutchie/cairn/discussions) or file an issue with the `question` label. We read every one and are happy to help orient you.

For security vulnerabilities, please see [SECURITY.md](SECURITY.md) rather than opening a public issue.
