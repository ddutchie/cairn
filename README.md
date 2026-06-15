# Cairn

<p align="center">
  <img src="public/icon.png" alt="Cairn" width="180" />
</p>

> A calm, local-first workspace for notes, project tracking, and visual idea mapping — with an AI assistant and MCP server built in.

<p align="center">
  <a href="https://ddutchie.github.io/cairn-site/index.html"><img src="https://img.shields.io/badge/Website-Live-blue" alt="Website"></a>
  <a href="https://ddutchie.github.io/cairn-site/docs"><img src="https://img.shields.io/badge/Docs-Read-green" alt="Docs"></a>
  <a href="https://github.com/ddutchie/cairn/releases"><img src="https://img.shields.io/github/v/release/ddutchie/cairn?label=Releases" alt="Releases"></a>
  <a href="https://github.com/ddutchie/cairn/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/ddutchie/cairn/issues"><img src="https://img.shields.io/github/issues/ddutchie/cairn" alt="Open Issues"></a>
  <a href="https://github.com/ddutchie/cairn/discussions"><img src="https://img.shields.io/badge/Discussions-Ask%20or%20share-blueviolet" alt="GitHub Discussions"></a>
  <a href="https://deepwiki.com/ddutchie/cairn/"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
</p>

<p align="center">
  <img src="public/hero.png" alt="Cairn screenshot" width="100%" />
</p>

## Overview

Cairn is a desktop app (Electron + Next.js) that combines markdown notes with a kanban board. It is fully compatible with Obsidian vaults, allowing you to point a workspace directly to any existing Obsidian folder. Notes are saved as plain `.md` files directly in your vault; project and task data lives in a local SQLite database alongside them. No accounts, no cloud, no backend. An embedded AI assistant and a standalone MCP server let AI agents read and write your workspace directly.

## Features

- **Projects** — Multiple projects inside a workspace, each with notes and a board
- **Notes** — Split-pane markdown editor (write on the left, preview on the right)
- **AI text actions** — Select any text in a note → floating toolbar → Rephrase, Summarize, Expand, Fix Grammar, Change Tone, or custom prompt
- **Kanban board** — Drag-and-drop cards across columns with priority indicators; Archive All Done button clears the Done column in one click; Archive view (Board / Archive toggle) shows all archived tasks in a searchable grid with restore and delete actions
- **Drag notes into folders** — Drag any note in the sidebar directly onto a folder row to move it; a "Move to root" drop zone appears while dragging
- **Linked context** — Notes and cards reference each other bidirectionally
- **Global search** — Instant full-text search across all notes and tasks (`⌘K` or `⌘⇧F`)
- **AI chat** — Integrated assistant with live project context; reads and writes your data (`⌘/`)
- **Interactive PRD generation** — Describe what you want to build; the agent asks clarifying questions then writes and saves a full PRD to your notes
- **Idea Flow** — Freeform node canvas per project (`⌘4`): ideas, note/task refs, groups, URLs, AI summaries — connected with labelled edges
- **Live dashboards** — AI-generated interactive HTML dashboards with a live `window.cairn.query()` data bridge; inline "Fix with AI" on runtime errors; editable via built-in CodeMirror overlay
- **MCP server** — Exposes your workspace to external AI agents (OpenCode, Claude Desktop, etc.) via the Model Context Protocol
- **Cairn Agent** — Native coding agent (`⌘5`) with board and notes integration: moves tasks, writes session notes, captures discovered work; supports subagents for deep sub-tasks; Plan / Execute mode toggle; interactive tool confirmations with mobile-desktop sync; automatic retry on transient API errors; LLM-based context compaction for long sessions; context usage ring; works with any OpenAI-compatible endpoint
- **Agent workspace** — Three-pane view (`⌘5`) for running external AI coding agents (Claude Code, OpenCode, Aider, or any CLI) connected to project tasks; file tree, multi-file CodeMirror 6 editor, xterm.js terminal, and git diff viewer
- **Knowledge Graph** — Workspace-wide graph of every note, card, project, and tag; Force-directed and Radial tree layouts; auto-discovered relationships (`⌘6`)
- **Insights** — Analytics view: Ridgeline joy plot, Beeswarm, Bullet health bars, Sankey pipeline flow, Timeline, Matrix heatmap, Table (`⌘7`)
- **Font scaling** — Five-step UI font size preference (XS–XL, default M) in Settings → General
- **Mobile Companion** — Access your workspace on any device (phone, tablet) over the local network via QR code or display PIN; features responsive layouts (slide-over drawers, fullscreen chat, wrapped note headers), Kanban touch drag-and-drop, full Idea Flow touch gestures (long-press canvas, single-tap node), and native PDF sharing sheets
- **Obsidian Vault Compatibility** — Works side-by-side with Obsidian vaults; renders standard double-bracket embeds (`![[image.png]]`), uploads files to custom attachment folders, resolves local media via sequential-fallback protocol, and merges YAML frontmatter non-destructively
- **Local-first** — Notes as `.md` files, project data in SQLite; no network required
- **Dark mode** — Calm, focused aesthetics

## Screenshots

<details>
<summary>View screenshots</summary>

<table>
  <tr>
    <td><img src="public/screenshots/notes.png" alt="Notes" /></td>
    <td><img src="public/screenshots/kanban.png" alt="Kanban board" /></td>
  </tr>
  <tr>
    <td><img src="public/screenshots/ai-chat.png" alt="AI chat" /></td>
    <td><img src="public/screenshots/knowledge-graph.png" alt="Knowledge graph" /></td>
  </tr>
  <tr>
    <td colspan="2"><img src="public/screenshots/idea-flow.png" alt="Idea Flow" /></td>
  </tr>
</table>

</details>

## Getting started

### Prerequisites

- Node.js 20+
- macOS (arm64 build provided; Windows/Linux untested)

### Install and run in development

```bash
git clone https://github.com/ddutchie/cairn
cd cairn
npm install
npm run rebuild   # build better-sqlite3 native binaries for Electron + system Node
npm run compile   # compile Electron main process + bundle MCP server
npm run dev       # start Cairn (Next.js + Electron)
```

### Build the packaged app

```bash
npm run build:mac      # macOS DMG (arm64 + x64)
npm run build:win      # Windows NSIS installer (x64 + arm64)
npm run build:linux    # Linux AppImage (x64 + arm64)
npm run build:all      # All three platforms
```

Output goes to `dist-app/`.

> **Note:** Re-run `npm run rebuild` after any Electron version bump. It builds native binaries for three ABIs (Electron, Node 22/MCP, system Node/vitest) and bundles the MCP server into a self-contained binary via `scripts/build-mcp-binary.js`.

## AI chat setup

Configure the AI endpoint in **Settings → AI & Chat** (no restart needed):

| Setting | Default | Notes |
|---------|---------|-------|
| Base URL | `https://api.openai.com` | Any OpenAI-compatible endpoint |
| Model | `gpt-4o-mini` | Any model name the endpoint accepts |
| API Key | _(blank)_ | Not required for local endpoints |

**Quick presets** — one click to switch between OpenAI, Ollama (`localhost:11434`), and LM Studio (`localhost:1234`). Local servers don't need an API key.

## Cairn Agent

Cairn includes a native coding agent that runs directly inside the app — no external CLI binary required. It is accessible from the Agent view (`⌘5`) by choosing **Cairn Agent** in the spawn modal.

The agent is inspired by [pi](https://github.com/earendil-works/pi), an open-source agentic coding framework. The tool implementations (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) are ported directly into the Electron main process and adapted for Cairn's architecture — same semantics, no npm dependency.

### What makes it Cairn-specific

Unlike a general coding agent, the Cairn Agent is a first-class participant in your project:

- **Board integration** — when you attach a task at spawn time, the agent moves it to In Progress immediately and to Review (or Done) when it finishes
- **Automatic notes** — findings, decisions, and bugs discovered during a session are written to project notes via `ensure_note` (idempotent — no duplicates on re-run)
- **Session summary** — a summary note is created at the end of every session documenting what changed and what needs follow-up
- **Out-of-scope capture** — issues found beyond the current task are automatically added to the board as new tasks

### Plan Mode

Launch the agent in **Plan Mode** to produce a spec before writing any code. The agent reads your codebase (read-only tools only) and writes a structured PRD note to your project. An **Approve Plan** button in the chat header then promotes the session to Execute Mode, injecting the full PRD as context for the coding run.

### Subagents

The agent can delegate contained sub-tasks to a fresh sub-agent via `spawn_subagent`. The sub-agent runs a full tool-call loop with its own message history — only its final answer is returned to the parent. This keeps the parent context lean for long multi-step tasks. The sub-agent trace is rendered inline and collapsible in the chat UI, with its own context usage ring.

### Context usage ring

A small ring in the agent pane header shows how full the model's context window is after each step. Configure the limit for your model in **Settings → AI & Chat → Context window** (presets: 8k / 32k / 128k / 200k).

When usage reaches 80% the agent automatically summarises older context with a background LLM call — the status bar shows `"Compacting context…"` while this is in flight. Type `/compact` in the chat input to trigger compaction on demand at any time. If a transient API error occurs, the status bar shows a countdown (`"Transient error — retrying (1/3) in 8s…"`) and the agent retries automatically.

## MCP server

Cairn ships a standalone stdio MCP server as a self-contained binary (`dist-mcp/cairn-mcp`), built with `@yao-pkg/pkg`. It connects directly to the same SQLite database as the app — writes are reflected in the UI in real time via WAL polling.

### Connect from OpenCode

Add to `opencode.json` in your project root:

```json
{
  "mcp": {
    "cairn": {
      "type": "local",
      "command": ["/Applications/Cairn.app/Contents/Resources/app.asar.unpacked/dist-mcp/cairn-mcp"],
      "enabled": true
    }
  }
}
```

### Connect from Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cairn": {
      "command": "/Applications/Cairn.app/Contents/Resources/app.asar.unpacked/dist-mcp/cairn-mcp"
    }
  }
}
```

> The exact paths above are generated automatically in **Settings → AI & Chat → MCP Server** — copy them from there.

### Available MCP tools

<details>
<summary>View all 37 tools</summary>

**Context**

| Tool | Category | Description |
|------|----------|-------------|
| `get_cairn_context` | read | Full orientation: workspaces, projects, column IDs, tool list, conventions |
| `get_project_context_pack` | read | Single-call bundle: project metadata + pinned notes + open tasks + recent activity |

**Notes**

| Tool | Category | Description |
|------|----------|-------------|
| `get_note` | read | Full markdown content, linked IDs, metadata, and `version` counter of a note by ID |
| `search_notes` | read | Full-text search across notes. Empty query returns all notes |
| `ensure_note` | write | Idempotent create-or-update by title — prevents duplicate notes on re-run |
| `append_to_note` | write | Append content to a note without re-sending the full body. Accepts optional `expectedVersion` for conflict detection |
| `patch_note` | write | Surgically replace a string inside a note — no need to re-send the full content. Accepts optional `expectedVersion` for conflict detection |
| `delete_note` | delete | Permanently delete a note |

**Tasks**

| Tool | Category | Description |
|------|----------|-------------|
| `get_task` | read | Full task detail by ID — includes `blockedByIds` and `version` counter |
| `list_ready_tasks` | read | Only unblocked, active tasks — use this to find work that can start now |
| `search_tasks` | read | Full-text search across task cards. Empty query returns all tasks |
| `create_task` | write | Create a task card in a column |
| `update_task` | write | Update a task's fields. Use `archived: true/false` to archive or restore. Use `blockedBy` to add a blocker, `unblockFrom` to remove one. Accepts optional `expectedVersion` for conflict detection |
| `bulk_update_task_status` | write | Move multiple tasks to the same column in one call |
| `link_note_to_task` | write | Bidirectionally link a note and a task |
| `delete_task` | delete | Permanently delete a task card |

**Projects**

| Tool | Category | Description |
|------|----------|-------------|
| `upsert_project` | write | Create or update a project. Omit `projectId` to create (auto-creates 5 default columns); provide `projectId` to update existing fields |
| `delete_project` | delete | Permanently delete a project and all its contents |

**Dashboards**

| Tool | Category | Description |
|------|----------|-------------|
| `create_dashboard` | write | Create a live HTML dashboard in a project |
| `update_dashboard` | write | Update an existing dashboard's title or HTML |
| `get_dashboard_constants` | read | Returns the `window.cairn` query API reference for building dashboards |

**Idea Flow**

| Tool | Category | Description |
|------|----------|-------------|
| `get_idea_flow` | read | Full Idea Flow graph: nodes (with resolved note/task content) + edges |
| `get_idea_flow_rules` | read | Returns node type conventions, data shapes, group rules, and positioning tips |
| `create_idea_flow_node` | write | Add a node to the canvas (idea, note_ref, task_ref, group, url, ai_summary) |
| `update_idea_flow_node` | write | Update a node's data and/or position (data fields are merged) |
| `layout_idea_flow` | write | Auto-arrange all nodes with Dagre. Call after bulk-creating nodes |
| `create_idea_flow_edge` | write | Connect two nodes with an optional label |
| `delete_idea_flow_node` | delete | Remove a node and its connected edges |
| `delete_idea_flow_edge` | delete | Remove a connection |

**Knowledge Graph**

| Tool | Category | Description |
|------|----------|-------------|
| `get_knowledge_graph` | read | Full workspace graph: projects, notes, cards, tags as nodes + edges |
| `get_neighbors` | read | N-hop neighbourhood around a single node |

**Tags**

| Tool | Category | Description |
|------|----------|-------------|
| `create_tag` | write | Create a workspace tag with a name and hex colour |

**Codebase**

| Tool | Category | Description |
|------|----------|-------------|
| `codebase_reindex` | write | Scan and semantic-index a codebase folder. Updates the SQLite cache of file paths, classes, functions, methods, docstrings, and call dependencies |
| `codebase_search_symbols` | read | Search for classes, functions, methods, interfaces, or structs by name or docstring query. Optional `folder` and `limit` parameters |
| `codebase_get_symbol_definition` | read | Lookup the definition signature, line numbers, and docstring of a symbol by its exact name |
| `codebase_get_references` | read | Find incoming references and outgoing dependencies (call graph) for a given symbol name |
| `codebase_get_file_symbols` | read | List all classes, functions, methods, interfaces, or structs defined in a specific file path |

</details>

> **Agent tip:** call `get_cairn_context` at the start of a session for all workspace/project/column IDs. Use `list_ready_tasks` instead of `search_tasks` when you want to know what work can actually start — it filters out anything blocked by an unresolved dependency. Use `update_task` with `blockedBy`/`unblockFrom` to manage task dependencies.

## Keyboard shortcuts

<details>
<summary>View all shortcuts</summary>

| Shortcut | Action |
|----------|--------|
| `⌘K` | Open global search |
| `⌘⇧F` | Global search (any view) / File search in Agent view sidebar |
| `⌘F` | In-context search — find/replace in Note or Agent editor; filter in Notes list, Board, or Knowledge Graph |
| `⌘N` | New note (switches to Notes view) |
| `⌘/` | Toggle AI chat |
| `⌘\` | Toggle sidebar |
| `⌘1` | Project overview |
| `⌘2` | Notes view |
| `⌘3` | Board view |
| `⌘4` | Idea Flow canvas |
| `⌘5` | Agent workspace |
| `⌘6` | Knowledge Graph |
| `⌘7` | Insights |
| `⌘S` | Save file (Agent editor) |
| `⌘Z` | Undo |
| `⌘⇧Z` / `⌘Y` | Redo |
| `Esc` | Close modal / search / filter bar |

</details>

## Architecture

Two processes share a single SQLite database (WAL mode):

- **Renderer** (`src/`) — React/Next.js. All data flows through IPC via `window.electron.*`; never touches the DB or filesystem directly.
- **Main process** (`electron/`) — Node.js. Owns SQLite, file I/O, AI chat loop, and PTY sessions for coding agents.
- **MCP server** (`electron/mcp-server.ts`) — self-contained binary; connects external agents to the same DB via WAL polling.

Notes are plain `.md` files (YAML frontmatter); SQLite is the read/search cache. Writes are atomic (`.tmp` rename). A chokidar watcher syncs external edits at runtime. `notes` and `task_cards` carry a `version` integer; MCP write tools accept `expectedVersion` for conflict detection.

For the full architecture reference see [CONTRIBUTING.md](CONTRIBUTING.md#architecture). AI coding agents should read [AGENTS.md](AGENTS.md) for conventions tuned to LLM context windows.

## Testing

```bash
npm test                 # unit & integration (Vitest)
npm run test:watch       # watch mode
npm run test:coverage    # coverage report
npm run test:e2e         # E2E smoke tests — headless Chromium, no Electron required
npm run test:e2e:ui      # Playwright UI mode
npm run test:e2e:headed  # headed for local debugging
```

Unit/integration tests (`electron/**/*.test.ts`) cover SQLite queries, file I/O, MCP tools end-to-end, chat executor tool cases, IPC handlers, and MCP↔chat tool parity. The E2E suite runs against the Next.js dev server with a full IPC mock — covers boot, all 8 views, and sidebar content in ~10s.

**Run `npm run test:e2e` before cutting a release** to catch renderer crashes unit tests can't reach.

## Tech stack

<details>
<summary>View full stack</summary>

**Platform**

| Tool | Role |
|------|------|
| Electron | Desktop shell |
| Next.js 16 | UI framework (App Router, static export) |
| TypeScript | Language |
| esbuild | Bundler (Electron main + MCP binary) |
| vitest | Unit & integration test runner |
| Playwright | E2E smoke tests (browser, no Electron required) |

**Data & AI**

| Tool | Role |
|------|------|
| better-sqlite3 | SQLite (dual ABI: Electron + pkg/Node 22) |
| gray-matter | YAML frontmatter parsing for note files |
| chokidar | File watcher for external `.md` edits |
| Vercel AI SDK | AI streaming utilities |
| @modelcontextprotocol/sdk | MCP server |
| Zod | Schema validation |
| nanoid | ID generation |

**UI & State**

| Tool | Role |
|------|------|
| Tailwind CSS v4 | Styling (CSS custom properties; never raw colour names) |
| Zustand | State management (domain slices: ui, workspace, board, notes, tags, chat, graph) |
| Radix UI | Accessible UI primitives (dialog, dropdown, tooltip, popover, select, context menu) |
| Lucide React | Icons |
| cmdk | Command palette |
| react-day-picker | Date picker |
| date-fns | Date utilities |
| tailwind-merge | Tailwind class merge utility |

**Editor & Agent**

| Tool | Role |
|------|------|
| CodeMirror 6 | Note editor + Agent file editor (CM6, CSS-hidden-per-tab pattern) |
| @codemirror/search | In-editor find/replace panel (`⌘F`) |
| node-pty | PTY process spawning (Agent terminal) |
| @xterm/xterm | Terminal emulator (Agent view) |
| @xterm/addon-fit | Terminal auto-resize |
| parse-diff | Git diff parser (Agent diff viewer) |

**Visualisation**

| Tool | Role |
|------|------|
| @xyflow/react | Node-based canvas (Idea Flow) |
| dnd-kit | Drag and drop (Kanban) |
| D3 v7 | Analytics & graph visualisation (Insights canvases, Radial tree) |
| react-force-graph-2d | Force-directed graph canvas (Knowledge Graph) |
| d3-sankey | Sankey pipeline diagram (Insights) |
| @dagrejs/dagre | Graph auto-layout (Idea Flow) |

**Markdown**

| Tool | Role |
|------|------|
| react-markdown | Markdown preview |
| remark-gfm | GitHub Flavored Markdown |
| remark-breaks | Hard line breaks in markdown |
| remark-math / rehype-katex | Math expression rendering |
| Mermaid | Diagram rendering in notes |
| lowlight | Syntax highlighting in code blocks |

</details>

> The **Settings → About** screen in the app shows real installed versions grouped by category (Platform, Data, AI, UI, Editor, Agent, Visualisation) and all open source licenses. These are generated automatically at build time — see below.

## Star History
<p align="center">
<a href="https://www.star-history.com/?repos=ddutchie%2Fcairn&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=ddutchie/cairn&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=ddutchie/cairn&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=ddutchie/cairn&type=date&legend=top-left" />
 </picture>
</a>
</p>

## Contributing

Contributions are welcome — bug fixes, features, docs, and tests. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide: dev setup, architecture, coding conventions, and PR checklist.

For security issues please see [SECURITY.md](SECURITY.md) rather than filing a public issue.

## License

MIT — see [LICENSE](LICENSE).