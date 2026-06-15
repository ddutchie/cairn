# Changelog

All notable changes to Cairn are documented in this file. This changelog is condensed to focus on major release cycles, combining minor features leading up to each version milestone. Detailed release histories can be found in the [changelogs/](file:///Users/gerard/Documents/GitHub/cairn/changelogs) directory.

## [2.0.1] — 2026-06-15

### Fixes
- **Asynchronous Codebase Indexing**: Converted the `codebase_reindex` tool and underlying scanner loops to run asynchronously, yielding to the Node event loop using `setImmediate` to prevent Electron main thread lockup.
- **Virtual Environment Exclusions**: Added `.venv`, `venv`, `env`, and `.env` directories to the default codebase indexer exclusions list, filtering out third-party dependencies from symbol searches.
- **Call Graph Noise Reduction**: Filtered out common programming language keywords and built-in names from outgoing call graph relations. Also fixed JS/TS method declaration parsing to prevent syntax keywords from matching as methods.
- **Subpath Folder Querying**: Refactored codebase queries to treat the `folder` parameter as a path prefix filter (`LIKE 'folder%'`), allowing searches to correctly narrow to subdirectories (e.g. `...\src\`).
- **Binary & Venv Exclusions in Grep**: Excluded virtual environment folders and binary file extensions (e.g. `.pyc`, `.class`) from grep searches, preventing binary garbage leakage.

---

## [2.0.0] — 2026-06-15

### Semantic Codebase Indexing & Querying
- **AST-Free Semantic Indexer**: Introduced an AST-free, regex-based codebase parser supporting C++, Java, C#, Go, Rust, Python, Ruby, and Shell scripts to map files, classes, functions, methods, docstrings, and references.
- **Integrated Coding Tools**: Exposes 5 new tools (`codebase_reindex`, `codebase_search_symbols`, `codebase_get_symbol_definition`, `codebase_get_references`, and `codebase_get_file_symbols`) to both the standalone MCP server and the internal agent loop.

### Dynamic Plan/Execute Mode Toggle
- Added a dynamic toggle badge/button in the agent panel header to switch coding agent sessions in real time between **Plan** mode (lower temperature, read-only outline) and **Execute** mode (full read/write).

### Interactive Tool Confirmations
- Added a security gate that pauses modifying tool calls (writes, edits, shell commands) when auto-approvals are turned off. Renders inline **Confirm** / **Deny** buttons directly in chat tool chips, with desktop-mobile setting sync.

### On-Device Llama Integration (llama.cpp) *(v1.7.x cycle)*
- **Cross-Platform completions**: Replaced macOS-restricted engines with a cross-platform offline `llama-server` completions engine.
- **1-Click native downloader**: Automated downloader that fetches platforms-specific prebuilts from `ggml-org/llama.cpp` and configures macOS FFI execution permissions.
- **Self-healing tool parser**: Implemented XML and JSON repairing in streaming completions to handle outputs from smaller quantized local models.

### Obsidian Vault Compatibility *(v1.5.x cycle)*
- **Obsidian vault support**: Drop intermediate `notes/` directory nesting to support standard Obsidian vault layouts.
- **Workspace migrations**: Automated workspace directory layout migration modal upon startup.
- **Double-bracket embeds**: Added native rendering for double-bracket image embeds `![[image.png]]`.
- **Vault-aware upload/paste**: Saves pasted images into configured Obsidian attachment folders and inserts vault-compatible markdown references.
- **YAML Frontmatter merging**: Uses a merge-not-replace YAML frontmatter sync to preserve custom vault properties like tags and aliases.

### Mobile Companion Integration *(v1.6.x cycle)*
- **Local network QR pairing**: Connect phones and tablets over local Wi-Fi with PIN/QR authentication.
- **Responsive touch interfaces**: Renders touch-optimized Kanban boards, slide-over drawers, full-screen mobile chat, and panning gestures for Idea Flow canvases.

### Context Size Optimization & Parity *(v1.8.x - v1.9.x)*
- **Preview truncation**: Optimizes context consumption by truncating search and pack previews, prompting agents to query full detail only when needed.
- **Tool shape parity**: Unified database mappings and note I/O to guarantee 100% tool shape consistency between the desktop chat and standalone MCP server.

---

## [1.0.0] — 2026-05-04

### Inline Coding Agent Workspace
- **Three-pane layout**: Resizable Agent view (`⌘5`) containing a directory **File Tree**, a multi-file tabbed CodeMirror 6 **Editor** with syntax highlighting, and tabbed **Terminal** sessions.
- **CLI agent support**: Runs binaries (Claude Code, OpenCode, Aider, or custom CLI scripts) inside a live xterm.js terminal powered by `node-pty`.
- **Git diff viewer**: Integrated tab rendering unified, split, or changes-only diffs with collapsible file blocks.
- **Task card spawning**: Reroutes prompt parameters from any task card to auto-orient the agent inside the project's code directory.

### Interactive PRD Generation *(v0.9.x)*
- Added interactive clarifying interview flows that collect requirements to automatically generate and save a detailed PRD note.

### Knowledge Graph *(v0.8.x)*
- Visual workspace graph mapping note, card, project, and tag connections in Force-directed or Radial tree layouts.

### Insights View *(v0.7.x)*
- Seven custom D3 analytics dashboards tracking project metrics (Ridgeline plots, Beeswarms, Bullet charts, Sankey pipelines, Timeline, and Heatmaps).

### Idea Flow Canvas *(v0.6.x)*
- Spatial freeform canvas to map ideas, link reference nodes, group topics, and leverage background AI graph summarization.

### Live Dashboards *(v0.5.x)*
- Live project HTML page sandboxes with custom inline `window.cairn.query()` data bridges.

### Core Productivity Foundation *(v0.1.x - v0.4.x)*
- Kanban board with WIP limits, card archiving, Markdown notes, wikilinks, tags, full-text global search (`⌘K`), and dark/light system theme engines.
