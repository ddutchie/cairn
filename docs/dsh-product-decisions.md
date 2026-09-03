# dsh Product Decisions

Tracker for dsh capabilities Cairn has evaluated but not adopted. Each entry is
a product call, not tech debt: adopting means a new user-facing surface, a new
dependency with native/platform implications, or a migration off a
Cairn-owned system. Status legend: **proposed** (awaiting decision) ·
**accepted** (do it, scoped) · **deferred** (revisit on trigger) ·
**blocked** (external constraint) · **wont-do** (explicitly out).

Context: full package inventory + UI-surface audit in the deep-dive session
(250 dsh packages, 61 adopted). Rule of thumb: version bumps deliver headless
surfaces (tools, projections, views) for free; visual components
(`dsh-client-ui-*`) target dsh's own web shell, not our Next.js renderer.

---

## Skills & MCP — Cairn-managed today, bridgeable tomorrow

Cairn owns this layer end-to-end: community plugin runtime (`plugin-loader.ts`,
`plugin-installer.ts`, `ui-plugin-handlers.ts`), the `cairn-skill-provider`,
slash-command merge, and the MCP SDK wiring. dsh offers the native halves:

| dsh package | What it adds | Decision needed |
|---|---|---|
| `dsh-mcp-client` | External MCP servers as native `ctx.tools` (sampling, elicitation, roots) | Whether to route community MCP connectors through it instead of the hand bridge. Risk: capability/approval-mapping parity with our EXEC/READ taxonomy. |
| `dsh-skill-filesystem` (+ `dsh-skill-badge`) | Local skill-root discovery + file watching | Whether project/user skill dirs should be discovered by dsh rather than our provider. Lower risk; mostly additive. |
| `dsh-hook-protocol` + `dsh-hooks-claude-code` / `dsh-hooks-codex` | Run Claude/Codex hooks on dsh interception seams | Whether community plugins should interoperate with those ecosystems. Defer until a plugin author asks. |

**Status: proposed.** Recommended path when accepted: keep Cairn's provider/registry
UX, adopt the dsh packages as *backends behind our seams* (same pattern as the
sharp-free attachment store), so community plugins keep working unchanged.
Do not expose dsh skill/MCP concepts directly in Settings until the bridge
proves parity.

## Remaining surfaces

### Persistent shell / PTY terminal — proposed
`dsh-terminal` + `dsh-terminal-bash` + `dsh-tool-terminal` (+ `dsh-tool-bash-persistent`
as the lighter alternative). Gives long-lived REPL/shell state and its UI.
Needs: a PTY backend choice (node-pty is already wired directly today — decide
whether dsh owns it), sandbox implications for persistent processes, and a
terminal panel design. One-shot `bash` + background jobs cover short commands
meanwhile.

### Feedback loop closure — proposed
Ratings/notes are stored (`message-feedback` sidecar) but nothing reads them:
no aggregation, no export, no telemetry backend. Decide what feedback is *for*
(model routing? prompt tuning? export for fine-tuning?) before building the
read side. Pairs with `dsh-session-telemetry` (opt-in only — local-first default
stays `disabled`).

### Model routing — deferred
Official `dsh-llm-deepseek` adapter + title-provider variants. The pi-ai twin
remains the only route until there's a provider DeepSeek serves that pi-ai
doesn't, or title quality demands the all-messages variant. Trigger: provider
gap or measurable title-quality win.

### Web research stack — deferred
`dsh-web` + `dsh-tool-web` (+ fetch/search providers) with untrusted-labeling.
Research-notes capability; overlaps MCP search connectors the community
already provides. Trigger: a first-party research use case (e.g. cited
answers in notes).

### LSP code navigation — deferred
`dsh-lsp` + `dsh-lsp-stdio` + `dsh-tool-lsp` (definition/references/hover).
Valuable for the coding surface, but needs a language-server lifecycle story
(install? bundled? which servers?). Trigger: coding-agent accuracy work that
needs precise navigation.

### Workflows + Ralph — deferred
`dsh-workflow` + `dsh-tool-workflow` (JS orchestration fanning out subagents)
and `dsh-tool-ralph` (fresh-agent loops toward an immutable objective).
Multi-agent automation; overlaps heartbeat automations conceptually. Trigger: an
automation that needs fan-out rather than a single headless turn.

### Cross-session references — deferred
`dsh-session-reference` (cross-session `@label` snapshot refs as untrusted
model context) and `dsh-file-reference` (+ `-local`, `@file` grammar). Core
notes-app primitives and the most philosophically aligned with Cairn — but both
touch the notes data model and the context pipeline. Worth a design doc before
any code. Trigger: links-between-sessions or @-mention completion work.

### Session-log export — deferred
`dsh-session-log-export` (ZIP export, header action + `/export`). Notes export
story; small. Trigger: user asks for portable transcripts.

### Loop hygiene — deferred
`dsh-repeat-tool-reminder` (nudge out of identical tool-call loops) and
`dsh-tool-call-timeout-policy` (per-tool deadlines → structured TOOL_TIMEOUT).
Cheap, but each adds a behavior users will notice (extra nudges, killed calls).
Trigger: observed stuck-loop or hang reports.

### Telemetry backend — wont-do (until asked)
`dsh-session-telemetry` (+ `-otel`). Correct default for a local-first app is
no telemetry pipeline. Revisit only with an explicit opt-in export feature.

### `dsh-attachment-local` — blocked
Needs real sharp; sharp ships no Windows-arm64 prebuild (see stub rationale in
`electron/sharp-stub/`). Cairn's sharp-free store stands. Unblocks on: a
pure-JS decoder, a platform-gated optional dep, or dropping the platform.

---

## Changelog

- 2026-09-03: created from the dsh deep-dive audit; skills/MCP framed as
  bridge-behind-our-seams. No decisions taken yet — all entries proposed
  except where marked.
