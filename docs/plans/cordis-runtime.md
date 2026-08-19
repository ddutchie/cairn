# Cairn Cordis Runtime — Rollout Plan

Status: **Proposal (validated by spike)** · Updated: 2026-08-19
Owner: Cairn maintainer
Related note: *DeepSeek Harness (dsh) integration analysis* (Cairn project)

## 1. Goal

Adopt the Cordis plugin framework (`@deepseek-ai/cordis`) as the engine behind Cairn's chat + agent surfaces — without shipping DeepSeek Harness the app. Cairn boots its own Cordis tree **in-process in Electron main**, consumes selected `@deepseek-ai/dsh-*` plugin packages from npm, and writes its own plugins for everything Cairn-specific. Users keep every existing integration (chat UI, message persistence, mobile sync, MCP connectors, community registry) unchanged, and gain the dsh plugin ecosystem (sandboxing, plan mode, approvals, skills, workflows, subagents) as an opt-in layer.

This plan is gated on the npm publish set stabilizing (see §6) — the architecture is proven; the distribution isn't.

## 2. Proof of concept (done — `scratch/dsh-spike/`)

### Spike 1 — npm consumability + tool registry — PASS
- `npm install @deepseek-ai/cordis @deepseek-ai/dsh-tools` resolves and installs in plain Node.
- A Cordis `Context` boots in-process; mounting `dsh-session`, `dsh-llm`, `dsh-system-prompt`, `dsh-agent`, `dsh-tools` (awaiting each fiber) registers `ctx.tools`.
- A tool defined with `defineTool` registers and executes through the full pipeline (`ctx.tools.execute` → pre-execute → guards → execute → post-execute → result) with cancellation signal support.

### Spike 2 — real end-to-end agent loop — PASS
- Wrote a minimal `LlmAdapter` subclass implementing the dsh-llm adapter seam against any OpenAI-compatible endpoint (used `http://localhost:3042/v1`, Rork bridge, model `claude-sonnet-4-5`).
- Booted the same Cordis tree, registered a real Cairn data tool (`cairn_list_notes`) backed by the **real** `getNotes` query from `electron/db/queries.js` on an in-memory DB with the real schema.
- Ran a manual agent loop: user message → model called `cairn_list_notes` → tool executed against SQLite → result fed back → model produced the correct final answer listing the seeded notes.
- **Proves:** the adapter seam is implementable (this is the `cairn-llm` port), and the tool bridge is nearly free (real query functions drop straight into a tool body).

### Key findings / risks surfaced
1. **npm distribution is incomplete.** `dsh-base` (the full bundle) fails to install — it depends on unpublished packages (`@deepseek-ai/dsh-environment`, `dsh-bash-env`, `dsh-tasks`) that 404. `dsh-skill-local` is also unpublished.
2. **Version drift across rc lines.** Packages publish at different rc versions (e.g. `dsh-tools` 0.0.1-rc.1 vs `dsh-agent-loop` 0.1.0-rc.6); caret ranges resolve a mixed tree. Consumers must pin the exact coherent snapshot from dsh's own lockfile, not trust ranges.
3. **Core loop is consumable today; capability plugins are not all consumable yet.** The 5 core packages (`cordis`, `dsh-llm`, `dsh-session`, `dsh-system-prompt`, `dsh-agent`, `dsh-tools`) install and run. `dsh-agent-loop` (the orchestrator) and several capability plugins pull missing deps.
4. **The tool registry API is more rigorous than Cairn's.** Every tool needs a mandatory typed output schema + render projection — a real (small) migration cost for the ~45 built-in tools, but it buys consistent replayable presentation for free.

## 3. Architecture

```
Cairn Electron main (in-process, no subprocess, no protocol bridge)
└── @deepseek-ai/cordis Context (ctx)
    ├── Borrowed dsh packages (Phase 1)
    │   ├── dsh-session, dsh-llm, dsh-system-prompt, dsh-agent, dsh-tools
    │   └── dsh-agent-loop (orchestrator — Phase 1b once npm completes)
    ├── Borrowed capability plugins (Phase 2, adopt one per release)
    │   ├── plan-mode, permission + user-approval, sandbox-*, compaction,
    │   │   subagent-*, workflow, skill, tool-web, token-meter, session-query-sqlite
    └── Cairn's own plugins (write once, Phase 1)
        ├── cairn-db             — wraps the existing db handle + queries/graph-queries (ABI-safe)
        ├── cairn-llm            — ctx.llm adapter for Cairn's providers (OpenAI-compat / Responses / localllm)
        ├── cairn-tools          — register the ~45 data tools on ctx.tools (bodies already exist in electron/mcp/tools/*)
        ├── cairn-external-tools — bridge user MCP servers + custom services into ctx.tools
        ├── cairn-session        — session/event → chat_threads/chat_messages (renderer + mobile bridge unchanged)
        ├── cairn-ui-bridge       — agent/session/tool events → existing chat:token/tool-call/done IPC
        └── cairn-community       — map personalities / slash commands / automation recipes onto the Cordis tree
```

**Non-negotiable invariants:**
- `Database` is still constructed only in `electron/db/client.ts` and the MCP runtime — the ABI rules in AGENTS.md stay untouched.
- The renderer keeps talking the exact same IPC surface (`chat:stream` / `chat:token` / `chat:tool-call` / `chat:done`). Only the engine call site in `electron/ipc/chat.ts` changes.
- Chat messages still land in `chat_threads` / `chat_messages` (SQLite), so the mobile SSE bridge, pop-out window, and PreviewPane keep working with zero UI changes.

## 4. Phased rollout

### Phase 0 — Stabilize the dependency baseline (0.5–1 week)
- [ ] Get the canonical coherent version snapshot: `git clone` dsh repo, read the top-level `package.json` / lockfile, record the exact package→version matrix that bootstraps a working tree (npm install by hand in a temp dir).
- [ ] Vendor the missing packages if they stay unpublished (`dsh-environment`, `dsh-bash-env`, `dsh-tasks`, `dsh-skill-local`) — or wait for the publish set to complete; decide based on dsh's release cadence.
- [ ] Decide npm vs. vendored source: prefer npm deps; fall back to vendoring like dsh vendors cordis (they proved the pattern).

### Phase 1 — Core engine swap behind a toggle (2–3 weeks)
- [ ] `cairn-llm` — implement the dsh-llm adapter for Cairn's existing providers (reuse `electron/lib/llm-transport.ts`, `llm-stream.ts`, `llm.ts`). The spike proves the seam.
- [ ] `cairn-tools` — a thin adapter that wraps the ~45 built-in tools + external MCP/services into `ctx.tools` definitions (schema conversion from Zod tool-schemas.ts → dsh ValueSchemaSpec).
- [ ] `cairn-session` + `cairn-ui-bridge` — map dsh session events → existing IPC events and SQLite tables.
- [ ] Wire `runToolLoop` call site in `electron/ipc/chat.ts` to the Cordis agent loop behind a settings toggle ("Chat engine: Built-in | Cordis").
- [ ] Ship behind the toggle; default stays Built-in until parity is proven.

### Phase 2 — Adopt capability plugins one per release (each 1–2 weeks)
- [ ] Approval gating + sandboxing (OpenWorker Phase 1 alignment) → `dsh-permission` + `dsh-user-approval` + `dsh-sandbox-*`
- [ ] Plan mode → `dsh-plan-mode`
- [ ] Skills → `dsh-skill-*` (unblocks the "Registry 3: Skills" backlog card)
- [ ] Workflows / automations v2 → `dsh-workflow-worker-thread` + `dsh-schedule`
- [ ] Session fork/resume/replay + auto-titles → `dsh-session` + `dsh-session-title-*`

### Phase 3 — In-app user plugins (the big unlock, 3–6 weeks)
Users write/install Cordis plugins inside Cairn.
- [ ] A "Plugins" settings tab that manages a patch layer (`cordis.patch.yml`-style) and installs npm packages into a bundled plugin dir.
- [ ] Plugin sandbox: user plugins run in a restricted Node context (limited fs/net) or spawn worker threads — never raw Electron-main access without explicit approval.
- [ ] A plugin authoring surface: editor pane + debug console + live reload (Cordis HMR is already built in).
- [ ] Publish Cairn's own plugins (`cairn-db`, `cairn-tools`) to npm so the ecosystem can build on them.

## 5. What users get

- The entire dsh plugin ecosystem becomes installable in Cairn (as npm settles) — sandboxing, approvals, plan mode, skills, workflows, subagents.
- Cairn keeps its identity: local-first, offline-capable PKM with a polished UI — the engine underneath is swappable, the product layer is untouched.
- Future-proofing: every Cairn feature becomes a plugin; the community registry becomes the storefront for Cairn plugins.

## 6. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Pre-1.0 framework fork as core dep; compat-breaking promised | High | Pin exact versions; upgrade on Cairn's schedule; vendor/fork if a fix stalls (dsh's own pattern). |
| npm publish set incomplete (missing 4+ packages) | High | Phase 0 baseline snapshot; vendor missing pieces; track upstream publishing. |
| Version drift across rc lines | High | Never trust ranges; pin the coherent lockfile snapshot. |
| Adapter fidelity for interactive UX (streaming tokens, subagent blocks, question forms) | Medium | Map dsh events → existing IPC event shapes (spike validated the vocab exists); keep Built-in loop as fallback. |
| Electron runtime compatibility | Low | dsh targets Node 22.19+; Electron 43 ships Node 22 — verified compatible. |
| Tool schema migration (~45 tools) | Medium | Mechanical conversion from Zod → ValueSchemaSpec; the pipeline enforces output schemas we already have. |

## 7. Decision log

- 2026-08-19: Spikes pass. Chose in-process Cordis tree over ACP sidecar (no subprocess, no protocol loss, tool execution stays on the real DB handle). Adopt behind a toggle, not a replacement.