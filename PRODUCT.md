# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary — dual audience (confirmed mix of builders + knowledge workers):**

1. **Developers & small product teams / solo builders** — orchestrating notes, kanban, idea graphs, and coding agents in a single local workspace. They point Cairn at a repo or Obsidian vault, track tasks on a board, sketch flows, and let the embedded Cairn Agent (or an external agent via MCP) read/write the same files + SQLite source of truth.
2. **Knowledge workers & Obsidian users** — writers, researchers, and systems thinkers who want a calm, focused overlay on their existing vault. They use split-pane markdown, linked context, knowledge graphs, and insights without migrating data or adopting a cloud account.

Both audiences are local-first by preference or policy: they value owning `.md` files on disk, offline access, and no vendor backend. Secondary: AI-augmented operators who use MCP to let agents automate note/board/idea-flow work.

**Situation & job:** When scattered notes, tasks, and half-formed ideas need to become shipped work — capturing thought in markdown, tracking it on a board, visualizing it in Idea Flow / Knowledge Graph, and handing it to an agent to execute — all without leaving a calm, distraction-free desktop.

## Product Purpose

Cairn is a local-first desktop workspace (Electron + Next.js) that unifies **markdown notes, kanban boards, and visual idea mapping** with an **embedded AI assistant, native coding agent, and MCP server**. It is fully compatible with Obsidian vaults: notes are plain `.md` files with YAML frontmatter on disk; project/task data lives in a local SQLite database alongside them (WAL mode). No accounts, no cloud, no backend.

Success is a user staying in a single, calm environment from thought → plan → execution: capture in notes, clarify in Idea Flow / Knowledge Graph, track on the board, and delegate to the agent — with every write reflected locally and available to external agents via MCP.

## Positioning

**Calm & focused craft — the quiet alternative to bloated all-in-ones.** Where Notion/Linear/Obsidian plugins sprawl or demand cloud lock-in, Cairn is deliberately minimal, dark, and focused. Its meaningfully different mechanism is **local-first ownership with agent-native reach**: plain markdown + SQLite stays on your machine and inside your vault, while `window.cairn.query()` dashboards, the Cairn Agent (board-aware, plan-mode, sub-agents), and a standalone MCP binary let any AI agent read and write the same workspace — even while the app is closed (WAL polling).

## Operating Context

- **Workflows & views:** Overview (`⌘1`) → Notes (`⌘2`, split write/preview) → Board (`⌘3`, drag-drop kanban with archive) → Idea Flow (`⌘4`, freeform canvas: idea / note_ref / task_ref / group / url / ai_summary nodes + labelled edges) → Agent workspace (`⌘5`, file tree + CodeMirror editor + xterm PTY + diff) → Knowledge Graph (`⌘6`, Force + Radial) → Insights (`⌘7`, seven analytics canvases) → Settings. Global search (`⌘K` / `⌘⇧F`), AI chat (`⌘/`), interactive PRD generation, AI text actions on selected text, live dashboards (HTML + CodeMirror overlay + "Fix with AI").
- **Environments:** Electron desktop (macOS arm64 + x64 DMG, Windows NSIS, Linux AppImage). Renderer (`src/`) is Next.js 16 App Router static export; Main process (`electron/`) owns SQLite, file I/O, AI loop, PTY. Two processes share one WAL SQLite. MCP server (`electron/mcp-server.ts` → `dist-mcp/cairn-mcp`) is a self-contained `@yao-pkg/pkg` binary bundling its own Node + better-sqlite3 — runs independently of the app.
- **Vault interoperability:** Point a workspace at any existing Obsidian folder. Renders `![[embed]]`, respects custom attachment folders, resolves local media via sequential-fallback, merges frontmatter non-destructively. Chokidar watches external `.md` edits at runtime.
- **Mobile companion:** Local-network QR / PIN access with responsive drawers, touch drag-drop, and Idea Flow gestures; native PDF share sheets.
- **Data shape:** Workspace → Project → Notes (.md + SQLite row) / Dashboards (SQLite only, `type="dashboard"`) / BoardColumns → TaskCards / IdeaFlow → IdeaFlowNodes + IdeaFlowEdges / ChatThreads → ChatMessages.

## Capabilities and Constraints

**Confirmed capabilities**
- Multi-workspace, multi-project; `.md` notes (split pane, TOC, callouts, Mermaid/math, backlinks, CodeBlock, wikilink picker, drag notes to folders / "Move to root").
- Kanban with dnd-kit, priority, archive view + restore/delete, Archive All Done, cross-project drop.
- Bidirectional note ↔ card linking; global full-text search.
- AI chat with live project context; AI text actions (Rephrase/Summarize/Expand/Fix Grammar/Change Tone/custom).
- Idea Flow (XYFlow + Dagre auto-layout), Knowledge Graph, Insights (Ridgeline/Beeswarm/Bullet/Sankey/Timeline/Matrix/Table).
- Native Cairn Agent inspired by `pi` (tool semantics ported to Electron main): board integration, auto-notes, session summary, out-of-scope capture, Plan/Execute toggle, subagents, context ring + 80% auto-compaction + `/compact`, retry, confirmations.
- Live dashboards via `window.cairn.query()` bridge; inline Fix with AI; CodeMirror HTML overlay.
- MCP: 37 tools (context, notes, tasks incl. `list_ready_tasks`/`bulk_update_task_status`, projects, dashboards, flow, graph, tags, codebase indexing via `codebase_reindex/search_symbols/get_definition/get_references/get_file_symbols`).
- Font scaling (XS–XL, default M via `--font-scale` on `<html>`), dark/light themes, accent presets (Sage Moss default `#8faf6f`), font-family presets, chat themes, onboarding, What's New modal.
- better-sqlite3 v13+ N-API (single prebuild fanned to `electron-native/`, `pkg-native/`, `vitest-native/`), onnxruntime-node pinned to 1.23.0 for darwin/x64, embeddings + runtime servers.

**Constraints (must preserve)**
- **Local-first only:** No cloud sync, no backend — `.md` + SQLite is source of truth; renderer never touches DB directly — all writes via IPC (`ipc`/`ipcAwait`).
- **Obsidian vault compatibility** is a commitment, not a perk.
- **DB bootstrap sites:** Only `electron/db/client.ts` (Electron) and `mcp-server.ts` / packaged `cairn-mcp` may construct `Database` (with `nativeBinding` per arch). No other `new Database()`.
- **Styling:** Tailwind v4 via CSS vars (`var(--background)`, `var(--accent)`, …); alpha via `color-mix()`; font sizes `rem`-based, SVG `fontSize` multiplied by `useFontScale()`.
- **Build:** `npm run compile` (esbuild, stricter than tsc — backticks in template literals must be unescaped) + `type-check:all`; version bump only via `scripts/release.sh` / `releasemobile.sh`.
- **Changelog / What's New:** Every user-facing change gets an entry in `changelogs/vX.Y.Z.md` ahead of current `package.json` version (2.7.6); headline features also appended to `scripts/features.config.js` → `src/generated/new-features.json` via `node scripts/generate-features.js`.

**Explicitly undecided**
- Distribution beyond desktop (full native mobile) — Mobile Companion is local-network companion only.
- Cloud/teams/multiplayer — out of scope for local-first position.
- Pricing/tiers beyond MIT local — not defined.

## Brand Commitments

- **Name & metaphor:** "Cairn" — stacked-stone wayfinding mark. Icon is the Cairn stone mark (`public/icon.png`), hero image, calm wayfinding language. Preserve metaphor (guidance, quiet accumulation, not flashy tech).
- **Voice:** Calm, focused, precise — "a calm, local-first workspace." Not loud, not gamified.
- **Palette:** Dark-first; default Sage Moss accent (`#8faf6f` / `#5c7a3f` light, `#8faf6f` dark) via `shared/ui/accents.ts` (`DEFAULT_ACCENT_ID`). All colour via CSS custom properties; never raw Tailwind names. Light theme exists but dark is canonical.
- **Typography:** System stacks — Geist sans (`--font-sans`), Geist Mono, serif display fallback (`New York`/`Iowan Old Style`/Palatino/Georgia). Playfair Display removed to avoid external requests in packaged app; note font switchable (sans/serif/mono presets in `shared/ui/fonts.ts`).
- **Assets on hand:** `public/icon.png`, `public/hero.png`, `public/screenshots/*`, `public/cairn-word.png`, site at `ddutchie.github.io/cairn-site`, releases on GitHub. MIT license.
- **Binding constraints:** Keep calm dark aesthetic; keep local-first + Obsidian compatibility; keep MIT + no-cloud promise. Evolution is refinement, not rebrand — redesign would need explicit user direction.

## Evidence on Hand

- **Real product:** Electron + Next.js 16 app at `/src` + `/electron`, package `cairn@2.7.6`, MIT licensed. Ships macOS (arm64+x64) DMG via electron-builder.
- **Existing visual implementation:** Dark token system in `src/app/globals.css` (`--background` `#0d0d0d` / `#f5f4f1`, `--accent` sage, `--surface*`, `--border`, `--text-primary/secondary/tertiary`, `--font-scale`), Radix UI + Lucide + Tailwind v4 + CodeMirror 6 + XYFlow + D3 v7.9.0.
- **Content & data:** Markdown notes on disk, SQLite WAL (`better-sqlite3` queries in `electron/db/queries.ts` + `graph-queries.ts`), IPC split (`electron/handlers.ts`), MCP bridge, onboarding (`src/components/onboarding`), What's New via `scripts/features.config.js`.
- **What is absent / must not be fabricated:** No hosted testimonials, case studies, pricing, or user metrics in repo; no cloud uptime claims; no invented user quotes.
- **Docs:** `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `AGENTS.md` (Next.js 16 caveats), `docs/`, changelogs at `changelogs/` (ahead-of-version rule), mobile at `mobile/` (Expo version separate).

## Product Principles

1. **Local-first, always ownable.** Files on disk and WAL SQLite are the system of record — agents and UIs are consumers, not owners. If it can't work offline with the app closed, it's the wrong abstraction.
2. **Calm is a feature.** Every interaction should reduce cognitive load: restrained palette, rem-scaled typography, motion only when it clarifies, dense not noisy. Peak craft is quiet.
3. **Obsidian-compatible, never extractive.** Respect the vault, its embeds, attachments, and frontmatter. Cairn augments a user's existing practice; it doesn't replace or re-serialize their archive.
4. **One workspace, many lenses.** Notes, board, graph, flow, insights and agents are views over the same data. Linking and context are bidirectional and lossless — a note, a card, and an agent should agree.
5. **Agents as careful participants.** Automation writes auditable notes, moves cards transparently, and captures what it discovers — it never silently diverges from the board. Plan before execution; compact before truncation.

## Accessibility & Inclusion

- Five-step `--font-scale` (1 / 1.1 / 1.2 (default) / 1.3 / 1.4) set inline on `<html>`; all sizing rem-based, SVG scaled via `useFontScale()`.
- Keyboard shortcuts for all views (`⌘1–7`, `⌘K`, `⌘/`, `⌘\` etc.); focus rings via `:focus-visible` on `var(--accent)`.
- Light + dark themes (dark canonical), with accent foregrounds checked for AA contrast.
- Follow WCAG 2.2 AA where applicable; no product-specific accessibility commitments beyond font scaling and keyboard operability have been explicitly established.
