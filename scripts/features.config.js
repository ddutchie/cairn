/**
 * Cairn — "What's New" feature source of truth (curated).
 *
 * This is the hand-authored list of MAJOR, user-facing features surfaced in the
 * What's New modal (src/components/layout/NewFeatureModal.tsx). It is the input
 * to scripts/generate-features.js, which validates it and writes the baked
 * src/generated/new-features.json the app reads at runtime — mirroring how
 * scripts/generate-licenses.js turns the curated ROLE_MAP into licenses.json.
 *
 * ── When to add an entry ──────────────────────────────────────────────────────
 * Add an entry ONLY for a major, headline feature a user would want announced on
 * launch — not every changelog line (fixes, small tweaks, and internal work stay
 * in changelogs/ only). Append new entries at the END, in release order. The
 * modal auto-shows unseen entries belonging to the newest MINOR version present
 * (so a headline feature dropped in 2.6.1 still surfaces to users who saw 2.6.0;
 * the per-user "seen" ids make sure already-dismissed entries never re-show).
 *
 * ── Condensing older minors (housekeeping) ─────────────────────────────────────
 * One card per MINOR version. When a new minor ships (e.g. v2.6.0), condense the
 * previous minor's cards into a single "vX.Y.x" entry so the registry stays
 * readable:
 *   id          "v2.5.x" — stable per minor, never reused.
 *   version     "v2.5.x" — the ".x" suffix marks a condensed minor line; the
 *               generator accepts it and it still groups under the minor in the
 *               boot gate.
 *   title/desc  A short "Cairn 2.5 — Highlights" summary.
 *   highlights  One "Prefix:" line per feature that shipped in that minor.
 * Condensed cards are NEVER auto-shown (they aren't the newest minor); they only
 * appear when the user browses What's New from Settings (forceOpen).
 *
 * ── Entry shape ───────────────────────────────────────────────────────────────
 *   id          Stable unique key, e.g. "v2.5.9-saved-providers". NEVER reuse or
 *               renumber — it's how "already seen" is tracked per user.
 *   version     Release tag string, e.g. "v2.5.9" (or "v2.5.x" for a condensed
 *               minor card). Group multiple features of the same release under
 *               the same version.
 *   title       Short headline (a few words).
 *   category    One-word-ish label shown as the eyebrow (e.g. "AI Chat", "Agent").
 *   description  One or two sentences of context.
 *   highlights  3–4 bullet strings. "Prefix: rest" bolds the prefix in the modal.
 *
 * @typedef {{ id: string, version: string, title: string, category: string,
 *             description: string, highlights: string[] }} NewFeature
 * @type {NewFeature[]}
 */
const FEATURES = [
  {
    id: "v0.x",
    version: "v0.x",
    title: "Cairn 0.x — The Beginning",
    category: "Release Highlights",
    description: "Where Cairn started: notes, boards, tags, and folders, the knowledge graph, task blockers, rich markdown, and the interactive PRD generator.",
    highlights: [
      "Knowledge Graph: Force-directed and radial tree layouts over projects, notes, cards, and tags, with auto-discovered relationships (co-mention, keyword similarity, shared assignee).",
      "Task Blockers: Mark one card as blocking another and see the dependency chain on the board and in the graph.",
      "Rich Markdown: Callouts, KaTeX math, highlights, and footnotes in notes and chat, with content-addressed image serving.",
      "Undo & Redo: ⌘Z / ⌘⇧Z across notes, the board, and Idea Flow — rapid typing coalesces into single undo steps.",
      "PRD Generation & Question Forms: Generate product-requirement notes interactively, with inline question forms the AI fills in chat.",
      "Onboarding Wizard: A guided first-run setup with an AI enable/disable toggle and instant workspace setup.",
    ],
  },
  {
    id: "v1.x",
    version: "v1.x",
    title: "Cairn 1.x — Highlights",
    category: "Release Highlights",
    description: "The foundations: wikilinks and backlinks, a plan-then-execute coding agent with skills, Obsidian vault compatibility, on-device local LLMs, and the mobile companion.",
    highlights: [
      "Wikilinks & Backlinks: Link notes with `[[Title]]` and see every note that references the current one in a dedicated backlinks panel.",
      "Plan Mode: Launch the coding agent in read-only planning mode — it writes a grounded PRD note you approve before it executes.",
      "Skill System: The agent discovers and loads SKILL.md files from your project and home directories, compatible with OpenCode, Cline, and Claude Code.",
      "Obsidian Vault Compatibility: Point any Cairn workspace directly to an Obsidian folder, with native `![[image]]` embeds and vault-aware assets.",
      "Decoupled AI Configurations: Run lightweight on-device models for inline editor actions while using large cloud endpoints for coding loops.",
      "Local LLM Integration: Full cross-platform local engine routing — a 1-click llama-server binary downloader with CDN mirrors and self-healing output parsing.",
      "Mobile Companion Service: Secure, local-network mobile access to Cairn notes, boards, and agents via QR pairing, with touch DnD and PDF export.",
    ],
  },
  {
    id: "v2.0.x",
    version: "v2.0.x",
    title: "Cairn 2.0 — Highlights",
    category: "Release Highlights",
    description: "Codebase indexing and agent guardrails.",
    highlights: [
      "Semantic Codebase Indexing: Incremental parser mapping functions, classes, and call graph relations for Rust, Go, Python, and JS.",
      "Plan & Execute Toggles: Lower temperature Outline settings for safe, deterministic planning drafts.",
      "Modifying Tool Confirmation: Security gate pausing execution for inline Confirm/Deny tool approval in message bubbles.",
    ],
  },
  {
    id: "v2.1.x",
    version: "v2.1.x",
    title: "Cairn 2.1 — Highlights",
    category: "Release Highlights",
    description: "Local semantic search.",
    highlights: [
      "Semantic Neighbours: A packaged on-device embedding model links notes by meaning; the Knowledge Graph gains a \"semantic\" edge type.",
      "Section-Based Embeddings: Notes are split by headings so each section gets its own vector — multi-topic notes connect to the right clusters.",
      "Fully Offline: Inference runs in a local background worker (ONNX Runtime); nothing is sent to a cloud service.",
    ],
  },
  {
    id: "v2.2.x",
    version: "v2.2.x",
    title: "Cairn 2.2 — Highlights",
    category: "Release Highlights",
    description: "Reasoning and thinking streams.",
    highlights: [
      "Collapsible Thinking Blocks: Follow the model's reasoning stream. Blocks auto-collapse once generation starts.",
      "Context & Usage Metrics: View exact breakdown of answer tokens vs reasoning tokens in the ContextRing popover.",
    ],
  },
  {
    id: "v2.3.x",
    version: "v2.3.x",
    title: "Cairn 2.3 — Highlights",
    category: "Release Highlights",
    description: "Everything that shipped across the Cairn 2.3 line: polished Git workflows, dynamic chat layouts, guided tours, a calendar view, and external AI tools.",
    highlights: [
      "Polished Git Integrations: A Radix branch switcher, file-level and bulk discarding, and theme-aware action tooltips.",
      "Dynamic Chat Layout & Previews: Toggle the chat between right-docked and full-workspace modes, with side-by-side context previews and direct workspace navigation.",
      "Interactive Workspace Tour: Step through guided visual tours with a highlight portal that adapts to resizing — plus a paginated What's New carousel on launch.",
      "Calendar View: Schedule tasks by due date with month/week layouts, drag-to-reschedule, and overdue trays.",
      "External Tools: Connect the AI chat and agent to remote MCP servers and any HTTP API, per-project, with an AI tool builder and keychain-backed credentials.",
      "OAuth Sign-in for Remote MCP Servers: One-click sign-in to OAuth-gated servers — Figma, Linear, Notion, GitHub — with PKCE and automatic refresh.",
    ],
  },
  {
    id: "v2.4.x",
    version: "v2.4.x",
    title: "Cairn 2.4 — Highlights",
    category: "Release Highlights",
    description: "The mobile companion, device sync, and codebase architecture: Cairn 2.4 brought your workspace to your phone and made multi-device, shared-folder sync safe.",
    highlights: [
      "Mobile Companion App: An offline-first mobile client for notes, tasks, boards, folders, and AI chat — markdown parity with the desktop, reconciling when connected.",
      "Device Sync: Connect a shared cloud folder (iCloud, Dropbox, Syncthing) that your phone also points at — offline-first, append-only oplog files, never your database.",
      "Conflict-Safe Reconciliation: Concurrent edits resolve with last-writer-wins plus a preserved conflicted copy, with a side-by-side resolution dialog and automatic merge.",
      "Codebase Architecture: The Agent view visualises the indexed codebase — a zoomable module map, dependency matrix and graph, with explain-with-AI and a contextual editor panel.",
    ],
  },
  {
    id: "v2.5.x",
    version: "v2.5.x",
    title: "Cairn 2.5 — Highlights",
    category: "Release Highlights",
    description: "Everything that shipped across the Cairn 2.5 line: saved AI providers, project merging, accent colors, Obsidian vault import, custom slash commands, and community providers.",
    highlights: [
      "Saved AI Providers: Save several OpenAI-compatible connections and switch between them in a click — keys live in your OS keychain.",
      "Merge Projects: Consolidate two projects into one — all notes, tasks, columns, and Idea Flow nodes move across in a single action.",
      "Pick Your Accent Color: Ten curated accent presets, each tuned for light and dark themes, applied live across the whole app.",
      "Open an Obsidian Vault: Point Cairn at an existing vault — or drop a folder of notes in — and projects and notes appear automatically.",
      "Custom Slash Commands: Create your own slash commands for chat and the coding agent, with every built-in documented.",
      "Community AI Providers: Install ready-made AI providers from the cairn-community catalog with one click — just add your API key.",
    ],
  },
  {
    id: "v2.6.x",
    version: "v2.6.x",
    title: "Cairn 2.6 — Highlights",
    category: "Release Highlights",
    description: "Everything that shipped across the Cairn 2.6 line: heartbeat automations, connector-aware automations, vault import preview, the live preview editor, usage tracking, agent todos, chat personalities, and writing style.",
    highlights: [
      "Heartbeat Automations: Schedule background agent tasks that run while Cairn is open, with approve/deny gates and community recipes.",
      "Connector-Aware Automations: Automations can use your MCP servers and HTTP services (Linear, GitHub, Slack), with keys or OAuth asked at install.",
      "Vault Import Preview: Pointing at an Obsidian vault or Markdown folder shows exactly what it will adopt before any file is touched.",
      "Live Preview Editor: Callouts, code, tables, math, and Mermaid render inline as you write, with a follow-the-cursor preview panel.",
      "Usage View: Every LLM and agent call is recorded locally — tokens, cost, and volume with charts and a per-call history.",
      "Agent Todo List: The agent plans multi-step work with a live, collapsible, session-persistent todo list.",
      "Chat Personalities: Layer behavioral rules onto the system prompt from a community catalog or your own.",
      "Writing Style: A guided session builds a full style guide plus a cheat sheet so chat and the agent draft in your voice.",
    ],
  },
  {
    id: "v2.7.x",
    version: "v2.7.x",
    title: "Cairn 2.7 — Highlights",
    category: "Release Highlights",
    description: "Everything that shipped across the Cairn 2.7 line: the Responses API, the automation mini-app, note fonts, and full chat theming.",
    highlights: [
      "Responses API: Chat, the agent, one-shots, compaction, and subagents route through /v1/responses when the provider supports it, with automatic fallback to Chat Completions.",
      "Automation Mini-App: Turn a scheduled automation into a tiny app — Develop agent authors scripts in place, with env vars, keychain-only secrets, and a live run transcript.",
      "Note Fonts: Pick Sans, Serif, or Mono for note text — editor, preview, and PDF exports all follow, while UI stays on the system font.",
      "Chat Themes: Re-skin chat with five built-ins (Default, Paper, Terminal, Midnight, Aurora) plus community themes that arrive without an app update.",
    ],
  },
  {
    id: "v3.0.0-unified-runtime",
    version: "v3.0.0",
    title: "Unified Runtime & Shell",
    category: "Foundations",
    description:
      "Cairn 3.0 replaces the fragmented Chat/Coding/Automation stacks with one Cordis + DSH engine, makes every conversation a portable session, and tightens the shell around it — Rail, Instrument Overview, and health radar included.",
    highlights: [
      "One Engine: Chat, coding, automations, and one-shots share the same Cordis/dsh runtime, tool/command/skill registries, and dsh-native Plan Mode.",
      "One Session Everywhere: Append-only JSONL history, a single session:* transport, and session-bound pop-outs with a project-aware browser and truthful running state.",
      "Steerable Conversations: Reasoning-effort pill, per-message throughput/latency, pinned provider protocol, and a context ring that reconciles live.",
      "Calmer Shell: Rail + dock as default, Instrument Overview with KPIs and horizon flow, 6-axis health radar, Settings 14→8, and a refined ⌘K palette.",
    ],
  },
];

module.exports = { FEATURES };
