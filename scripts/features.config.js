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
    id: "v2.6.0-heartbeat-automations",
    version: "v2.6.0",
    title: "Heartbeat Automations",
    category: "Automation",
    description: "Schedule background agent tasks that run while Cairn is open — morning briefs, weekly reviews, inbox tidy-ups. Review and approve what they do, and browse ready-made recipes from the community.",
    highlights: [
      "Schedule Without Cron: Build schedules visually — interval, daily, weekly day toggles, monthly, or a one-off — with a live 'next run' preview.",
      "Approve or Deny: Automations can run in 'ask' mode so each write action parks in an attention queue on the Overview for you to approve or deny.",
      "Live Run State: Cards show the current tool, an animated progress bar, and the notes/cards each run produced — click them to jump straight to the result.",
      "Community Recipes & Notifications: Start from a community recipe (automations.json) that pre-fills the form, and track every update in the notification center opened from the title-bar bell.",
    ],
  },
  {
    id: "v2.6.1-connector-automations",
    version: "v2.6.1",
    title: "Connector-Aware Automations",
    category: "Automation",
    description: "Automations can now use your attached MCP servers and HTTP services — Linear digests, GitHub PR summaries, Slack recaps. Required connectors are checked at setup, and their keys or OAuth sign-in are asked for at install.",
    highlights: [
      "Recipes That Need Connectors: New community recipes pull in Linear, GitHub, or Slack — the recipe card shows which connectors it needs and whether they're installed and attached to the project.",
      "Keys Asked At Install: Install a connector and you're prompted for its API key or OAuth sign-in on the spot — no guessing later where the key goes.",
      "Gated External Calls: Connector calls from an automation wait for your approval in the inbox by default — external side effects are never auto-approved.",
      "Connector Badges: Saved automations show the connectors they depend on, so you can see at a glance which ones need a key or a connection.",
    ],
  },
  {
    id: "v2.6.1-vault-import-preview",
    version: "v2.6.1",
    title: "See Before You Import",
    category: "Onboarding",
    description:
      "Pointing Cairn at an existing Obsidian vault or Markdown folder now shows you exactly what it will adopt before a single file is touched. Review the projects and note counts, untick the folders you want left alone, then confirm.",
    highlights: [
      "Read-Only Preview: Choosing a folder no longer changes it — Cairn scans and reports the projects and notes it found, and only writes once you confirm.",
      "Exclude What You Don't Want: Untick any top-level folder to leave it out, with counts updating as you go. Your choices stick for later scans and file watching.",
      "Sensible Defaults: Templates, attachments, asset folders, and Excalidraw drawings are skipped automatically, so scratch files don't become notes.",
      "Backup Reminder: The preview explains that Cairn adds a small frontmatter block on first touch and suggests a backup or git commit first.",
    ],
  },
  {
    id: "v2.6.3-live-preview-editor",
    version: "v2.6.3",
    title: "Live Preview Editor",
    category: "Editor",
    description:
      "The note editor now renders rich blocks inline as you write — callouts, code blocks, tables, math, and Mermaid diagrams all show the way they will in reading mode, and click straight into raw Markdown to edit. A preview panel follows your cursor so you can watch a table or diagram take shape, and instantly spot broken Markdown.",
    highlights: [
      "Inline Everything: `> [!note]` callouts, fenced code (with highlighting + copy), GFM tables, $$ math, and ```mermaid diagrams render live in the editor — click any block to edit its raw Markdown.",
      "Edit / Read + Live Preview: Two clear modes, plus a Live Preview toggle to flip inline rendering off and edit the plain source when you need to.",
      "Follow-the-Cursor Preview: The bottom panel live-renders the table, callout, code, or math block you're editing — a broken table or unclosed fence shows immediately. Resize it S / M / L.",
    ],
  },
];

module.exports = { FEATURES };
