# Changelog

All notable changes to Cairn are documented in this file. This changelog is condensed to focus on major releases. Detailed notes for all minor and patch releases can be found in the [changelogs/](file:///Users/gerard/Documents/GitHub/cairn/changelogs) directory.

## [2.0.0] — 2026-06-15

### Semantic Codebase Indexing & Query Tools
- **AST-Free Regex Indexer**: Recursively scans workspaces, comparing MD5 hashes to perform incremental indexing. Supports C++, Java, C#, Go, Rust, Python, Ruby, and Shell scripts to map files, symbols, and dependencies.
- **MCP & Coding Tools Integration**: Exposes 5 new tools (`codebase_reindex`, `codebase_search_symbols`, `codebase_get_symbol_definition`, `codebase_get_references`, and `codebase_get_file_symbols`) to the standalone MCP server and integrated agent loop.

### Dynamic Plan/Execute Mode Toggle
- Allows users to dynamically switch active coding agent sessions between **Plan** mode (lower temperature, read-only outline) and **Execute** mode (full read/write) in the UI.

### Interactive Tool Confirmations
- Implements a tool execution confirmation gate. When auto-approvals are turned off, the agent pauses before executing modifying tools, rendering inline Confirm/Deny buttons within the chat tool chips. Supports desktop-mobile sync.

---

## [1.0.0] — 2026-05-04

### Inline Coding Agent Workspace
- Introduces the **Agent** view (⌘5) allowing users to run AI coding tools — Claude Code, OpenCode, Aider, or any custom CLI binary — directly inside Cairn.
- Register agents in Settings and configure a code directory per project.

### Resizable Three-Pane Workspace
- Includes a lazy-expanding directory **File Tree** with type-aware icons.
- Includes a multi-file tabbed CodeMirror 6 **Editor** with syntax highlighting, ⌘S save, markdown preview, and undo/redo history.
- Includes a tabbed **Terminal** powered by xterm.js and `node-pty`.

### Git Diff Viewer
- Renders unified, split, or changes-only diff views for the project's code directory with collapsible file sections and a Copy Patch action.
