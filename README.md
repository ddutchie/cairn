# 🪨 Cairn

> A calm, local-first workspace for notes and project tracking — with an AI assistant and MCP server built in.

## Overview

Cairn is a desktop app (Electron + Next.js) that combines markdown notes with a kanban board. All data lives in a local SQLite database — no accounts, no cloud, no backend. An embedded AI assistant and a standalone MCP server let AI agents read and write your workspace directly.

## Features

- **Projects** — Multiple projects inside a workspace, each with notes and a board
- **Notes** — Split-pane markdown editor (write on the left, preview on the right)
- **AI text actions** — Select any text in a note → floating toolbar → Rephrase, Summarize, Expand, Fix Grammar, Change Tone, or custom prompt
- **Kanban board** — Drag-and-drop cards across columns with priority indicators
- **Linked context** — Notes and cards reference each other bidirectionally
- **Global search** — Instant full-text search across all notes and tasks (`⌘K`)
- **AI chat** — Integrated assistant with live project context; reads and writes your data (`⌘/`)
- **MCP server** — Exposes your workspace to external AI agents (OpenCode, Claude Desktop, etc.) via the Model Context Protocol
- **Local-first** — SQLite on disk; no network required
- **Dark mode** — Calm, focused aesthetics

## Getting started

### Prerequisites

- Node.js 20+
- macOS (arm64 build provided; Windows/Linux untested)

### Install and run in development

```bash
git clone https://github.com/YOUR_ORG/cairn
cd cairn
npm install
npm run rebuild   # build better-sqlite3 native binaries for Electron + system Node
npm run compile   # compile Electron main process + bundle MCP server
npm run dev       # start Cairn (Next.js + Electron)
```

### Build the packaged app

```bash
npm run build
# Output: dist-app/Cairn-0.1.0-arm64.dmg
```

> **Note:** `npm run rebuild` must be re-run after updating the Electron version. It saves two native binaries: one for the Electron ABI (`electron-native/`) and one for the system Node ABI used by the MCP server (`mcp-native/`).

## AI chat setup

Configure the AI endpoint in **Settings → AI & Chat** (no restart needed):

| Setting | Default | Notes |
|---------|---------|-------|
| Base URL | `https://api.openai.com` | Any OpenAI-compatible endpoint |
| Model | `gpt-4o-mini` | Any model name the endpoint accepts |
| API Key | _(blank)_ | Not required for local endpoints |

**Quick presets** — one click to switch between OpenAI, Ollama (`localhost:11434`), and LM Studio (`localhost:1234`). Local servers don't need an API key.

## MCP server

Cairn runs a standalone stdio MCP server (`dist-mcp/mcp-server.bundle.js`). It connects directly to the same SQLite database as the app — writes are reflected in the UI in real time.

### Connect from OpenCode

Add to `opencode.json` in your project root:

```json
{
  "mcp": {
    "cairn": {
      "type": "local",
      "command": ["node", "/Applications/Cairn.app/Contents/Resources/app.asar.unpacked/dist-mcp/mcp-server.bundle.js"],
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
      "command": "node",
      "args": ["/Applications/Cairn.app/Contents/Resources/app.asar.unpacked/dist-mcp/mcp-server.bundle.js"]
    }
  }
}
```

> The exact paths above are generated automatically in **Settings → AI & Chat → MCP Server** — copy them from there.

### Available MCP tools

| Tool | Category | Description |
|------|----------|-------------|
| `get_cairn_context` | read | Full orientation: workspaces, projects, column IDs, tool list, conventions |
| `search_notes` | read | Full-text search across notes |
| `search_tasks` | read | Full-text search across task cards |
| `get_note` | read | Full markdown content of a note by ID |
| `get_task` | read | Full detail of a task card by ID |
| `get_project_summary` | read | Column breakdown, card counts, recent activity |
| `list_recent_activity` | read | Recently created/updated notes and tasks |
| `create_project` | write | Create a project with default board columns |
| `create_note` | write | Create a markdown note |
| `update_note` | write | Update a note's title or content |
| `create_task` | write | Create a task card in a column |
| `update_task_status` | write | Move a task to a different column |
| `link_note_to_task` | write | Bidirectionally link a note and task |
| `delete_note` | delete | Permanently delete a note |
| `delete_task` | delete | Permanently delete a task card |

> Call `get_cairn_context` at the start of a session — it returns all workspace/project/column IDs and conventions in one call.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘K` | Open global search |
| `⌘/` | Toggle AI chat |
| `⌘\` | Toggle sidebar |
| `⌘1` | Project overview |
| `⌘2` | Notes view |
| `⌘3` | Board view |
| `Esc` | Close modal / search |

## Architecture

### Data model

```
Workspace
  └── Project
        ├── Note[]          (raw markdown in SQLite)
        ├── BoardColumn[]
        │     └── TaskCard[]
        └── ChatThread
              └── ChatMessage[]
```

Notes and task cards link bidirectionally via `linkedNoteIds` / `linkedCardIds`.

### Process model

Two processes share the same SQLite database (`~/Library/Application Support/Cairn/cairn/cairn.db`, WAL mode):

1. **Electron app** — Next.js rendered in a BrowserWindow. AI chat runs in the main process via IPC (`electron/ipc/chat.ts`) — works fully offline in the packaged app.
2. **MCP server** — Standalone Node.js stdio process (`dist-mcp/mcp-server.bundle.js`), launched by external agents. Writes to SQLite directly; the Electron UI refreshes automatically via `-wal` mtime polling.

### Key files

| File | Purpose |
|------|---------|
| `electron/main.ts` | BrowserWindow, IPC, `app://` protocol, WAL polling |
| `electron/ipc/chat.ts` | AI chat loop in main process; all chat tools |
| `electron/ipc/handlers.ts` | All `db:*` IPC channels |
| `electron/db/queries.ts` | SQLite query helpers |
| `electron/mcp-server.ts` | Standalone MCP server source |
| `src/store/index.ts` | Zustand store; `hydrateFromElectron()` |
| `src/components/notes/note-editor.tsx` | Split-pane markdown editor + AI text toolbar |
| `src/components/layout/project-overview.tsx` | Overview with stats and recent activity feed |
| `scripts/electron-build.js` | Full build pipeline (Next.js static export + Electron) |

## Tech stack

| Tool | Role |
|------|------|
| Electron | Desktop shell |
| Next.js 16 | UI framework (App Router, static export) |
| TypeScript | Language |
| Tailwind CSS v4 | Styling |
| Zustand | State management |
| better-sqlite3 | SQLite (dual ABI: Electron + system Node) |
| dnd-kit | Drag and drop |
| react-markdown | Markdown preview |
| Radix UI | Accessible UI primitives |
| esbuild | MCP server bundler |
| @modelcontextprotocol/sdk | MCP server |
| Lucide React | Icons |

## License

MIT — see [LICENSE](LICENSE).
