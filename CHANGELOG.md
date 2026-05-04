# Changelog

All notable changes to Cairn are documented in this file.

## [1.0.0] — 2026-05-04

- Inline coding agent workspace (⌘7) — run Claude Code, OpenCode, Aider, or any CLI binary inside Cairn
- Register agents in Settings → Coding Agents; set a code directory per project
- Spawn an agent from any task card with the prompt pre-filled from the card
- Three-pane layout: file tree, multi-file tabbed CodeMirror 6 editor, tabbed xterm.js terminal
- Git diff viewer with unified / split / changes views and syntax highlighting
- PTY sessions managed by `node-pty`; survive navigation and resize in real time

---

## [0.9.6] — 2025-04-19

- Interactive `ask_questions` flow and PRD modal in the chat interface
- Note drag-and-drop reordering; sidebar and dialog polish

## [0.9.5]

- AI toolbar, formatting toolbar, preview mode, and file-watcher fixes for notes

## [0.9.4]

- Fix note title lag and stale save race condition

## [0.9.3]

- Prevent file-watcher delete events from clobbering in-flight note edits; sync notes from disk on startup

## [0.9.2]

- Asset protocol: dynamic workspace path resolution; serve arbitrary files to the renderer

## [0.9.1]

- Onboarding wizard, mutable DB context, and database re-initialisation support

## [0.9.0]

- Global AI enable/disable toggle; AI features gated when disabled

## [0.8.0]

- Knowledge Graph view — force-directed and radial tree layouts

## [0.7.x]

- Insights view with seven analytics canvases (D3 v7)
- Font scale setting (XS → XL) with CSS `--font-scale` cascade

## [0.6.x]

- Idea Flow view (visual node graph with groups, URL cards, AI summaries)
- Bidirectional note ↔ task linking

## [0.5.x]

- Dashboards — live HTML canvases with `window.cairn` data API

## [0.4.x — 0.3.x]

- Kanban board, task cards, columns, priorities, due dates
- Notes with Markdown, wikilinks, file-watcher sync
- Tags, workspace/project management, dark/light/system themes
