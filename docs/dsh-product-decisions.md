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

**Status: accepted (2026-09-03 decision log, round 1).** MCP → parity-gated spike
(EXEC/READ approval mapping, sampling, elicitation must prove out before
merge); skill-filesystem → adopt as backend behind our provider; hooks →
adopt (demand question overridden — compatibility with the existing hooks
library wins). Recommended path stands: keep Cairn's provider/registry UX,
adopt the dsh packages as *backends behind our seams* (same pattern as the
sharp-free attachment store), so community plugins keep working unchanged.
Do not expose dsh skill/MCP concepts directly in Settings until the bridge
proves parity.

## Remaining surfaces

### Persistent shell / PTY terminal — accepted (2026-09-03 decision log, round 2)
`dsh-terminal` + `dsh-terminal-bash` + `dsh-tool-terminal`. Reframed during
review: the expensive halves already exist (`AgentBottomTerminal.tsx` =
xterm tabs over node-pty `agent:spawnShell` sessions) — what remains is a
`ctx.terminals` backend over the existing PTY sessions plus the model tools,
giving persistent model shells (REPL state, long compiles) with jobs-backed
background sends. Sandbox review for model-owned persistent processes is part
of the work. To implement: publish-check, terminals backend, mount tools,
wire output/progress into the jobs dock.

### Feedback loop closure — deferred (2026-09-03 decision log, round 2)
Ratings/notes are stored (`message-feedback` sidecar) but nothing reads them:
no aggregation, no export, no telemetry backend. Decide what feedback is *for*
(model routing? prompt tuning? export for fine-tuning?) before building the
read side. Pairs with `dsh-session-telemetry` (opt-in only — local-first default
stays `disabled`).

### Model routing — deferred (2026-09-03 decision log, final round confirmed)
Official `dsh-llm-deepseek` adapter + title-provider variants. The pi-ai twin
remains the only route until a provider gap appears or title quality demands
the all-messages variant. A second adapter is a second failure surface —
needs a reason.

### Web research stack — implemented (2026-09-03)
`dsh-web` + `dsh-tool-web` (+ fetch/search providers) with untrusted-labeling.
First-party cited answers in notes without requiring a connector. Untrusted-
labeling policy is part of the work. To implement: publish-check, provider
choice (DeepSeek/Exa/Perplexity — needs keys UX), mount, approval-class the
tools.
Outcome: shared-ctx mount (`dsh:web` pinned to `exa`/`http` providers +
`web_search`/`web_fetch` tools); Exa chosen for plain-API-key auth
(`$EXA_API_KEY`, fail-closed without it); tools ask every call by taxonomy
default (WRITE_LOCAL); provider output carries the untrusted-content notice.

### LSP code navigation — accepted (2026-09-03 decision log, round 3)
`dsh-lsp` + `dsh-lsp-stdio` + `dsh-tool-lsp` (definition/references/hover).
Rationale: the agent is code-oriented and first-party LSP has been wanted for
a while — dsh makes it possible. Language-server lifecycle (install? bundled?
which servers first?) is part of the work, not a blocker. To implement:
publish-check, lifecycle decision, mount, coding-stack integration.

### Workflows + Ralph — implemented (2026-09-03)
`dsh-workflow` + `dsh-tool-workflow` (JS orchestration fanning out subagents)
and `dsh-tool-ralph` (fresh-agent loops toward an immutable objective).
Ralph-style loops are the natural engine for long autonomous tasks; relationship
to heartbeat single-turn automations to be clarified during implementation
(fan-out vs single turn, not either/or). To implement: publish-check, mount,
automation-comparison note.
Outcome: worker-thread engine on shared ctx + `workflow`/`ralph` tools per
coding turn (bounded: 256-round / 1000-agent ceilings pinned in tests);
heartbeat stays the single-turn automation cadence — complementary, untouched.

### Cross-session references — accepted: design doc first (2026-09-03 decision log, round 3)
`dsh-session-reference` (cross-session `@label` snapshot refs as untrusted
model context) and `dsh-file-reference` (+ `-local`, `@file` grammar). Most
philosophically aligned with Cairn, but touches the notes data model and the
context pipeline — design doc before code. Audit touchpoint map is the
starting input.

### Session-log export — implemented (2026-09-03)
`dsh-session-log-export` (ZIP export, header action + `/export`). Notes export
story; small and self-contained. To implement: publish-check, mount, wire the
header action.
Outcome: `/export` command on the shared ctx writes the session ZIP to disk
(via existing command-palette merge, no new UI); web-shell header action +
HTTP route not applicable to Electron — renderer download button is the
follow-up.

### Loop hygiene — deferred (2026-09-03 decision log, final round confirmed)
`dsh-repeat-tool-reminder` (nudge out of identical tool-call loops) and
`dsh-tool-call-timeout-policy` (per-tool deadlines → structured TOOL_TIMEOUT).
Each adds user-visible behavior — pay that cost on evidence (stuck-loop or
hang reports), not as insurance.

### Telemetry — planned: first-party system, later (2026-09-03 decision log, final round)
dsh's `dsh-session-telemetry` (+ `-otel`) stays out — but the underlying need
stands: knowing which features get used. Plan for a Cairn-owned telemetry
system (feature-usage scope, local-first defaults, explicit opt-in story to be
designed) as its own project. Not dsh OTel, not now.

### `dsh-attachment-local` — blocked
Needs real sharp; sharp ships no Windows-arm64 prebuild (see stub rationale in
`electron/sharp-stub/`). Cairn's sharp-free store stands. Unblocks on: a
pure-JS decoder, a platform-gated optional dep, or dropping the platform.

---

## Changelog

- 2026-09-03: created from the dsh deep-dive audit; skills/MCP framed as
  bridge-behind-our-seams.
- 2026-09-03: decision log rounds 1–3 + final. Accepted: MCP spike
  (parity-gated), skill-filesystem, hooks, terminal bridge (over existing
  PTY), session export, web research, LSP, workflows/Ralph, cross-session
  refs design doc. Deferred: feedback read side, loop hygiene, model routing.
  Planned-later: first-party telemetry system.
