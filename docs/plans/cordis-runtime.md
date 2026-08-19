# Cairn Cordis Runtime — Rollout Plan

Status: **Active — Cordis is the default direction** · Updated: 2026-08-19
Owner: Cairn maintainer
Related note: *DeepSeek Harness (dsh) integration analysis* (Cairn project)

## 1. Goal

Make the **Cairn Cordis runtime the single, default engine** behind Cairn's chat + agent surfaces, so Cairn stops maintaining its own agent loops entirely. Cairn boots its own Cordis tree **in-process in Electron main**, consumes the dsh stack (`dsh-agent-loop` orchestrator + `dsh-llm-pi-ai` model transport + dsh capability plugins for plan-mode/bash/fs/subagents/approvals/sandbox), and writes **small `cairn-*` plugins** for every Cairn-specific concern — each parity gap is a plugin, not a fork.

**Strategy decision (2026-08-19):** Cordis is **default**. The built-in loops (`chat-loop.ts`, `pi-agent-loop.ts`, `chat-subagent-loop.ts`) become **frozen legacy** — reachable via an advanced setting/env var for rollback only, never developed in parallel. Delete them + the toggle once parity lands.

**The core idea:** every gap = a `cairn-*` plugin on the shared tree:
- `cairn-subagent` — bridge dsh subagent events → renderer `chat:subagent*` IPC
- `cairn-usage` — dsh usage/chunk events → `recordLlmUsage` + `chat:usage` + credit recovery
- `cairn-reasoning` — reasoning chunks → round-trip metadata on `chat_messages`
- `cairn-session` — dsh session events → `chat_threads`/`chat_messages` persistence
- `cairn-tools` — Cairn's ~56 data tools onto `ctx.tools` (done)
- `cairn-llm` — pi-ai adapter + profile for Cairn's endpoints (done)

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
└── @deepseek-ai/cordis Context (ctx)  ← default engine
    ├── dsh core: session, llm, system-prompt, agent, tools, agent-loop, scope,
    │   llm-retry, agent-default-model, llm-pi-ai
    ├── dsh capability plugins: plan-mode, permission-presets, user-approval,
    │   sandbox-local/policy, fs-sandbox, shell-env, subprocess-local, bash-local,
    │   tool-bash/fs/fs-search/str-replace/todo, agent-instructions, subagent,
    │   compaction-basic, token-meter, commands
    └── Cairn's own plugins (the parity layer — one per concern, not a fork)
        ├── cairn-db             — existing db handle + queries (ABI-safe)
        ├── cairn-llm            — pi-ai adapter + profile for Cairn's endpoints (done)
        ├── cairn-tools          — ~56 data tools onto ctx.tools (done)
        ├── cairn-external-tools — user MCP servers + custom services onto ctx.tools
        ├── cairn-session        — dsh session events → chat_threads/chat_messages (+ reasoning field)
        ├── cairn-usage          — dsh usage → recordLlmUsage + chat:usage + credit recovery
        ├── cairn-subagent       — dsh subagent events → chat:subagent* IPC
        └── cairn-community      — personalities / slash commands / automations onto the tree
```

**Non-negotiable invariants:**
- `Database` is still constructed only in `electron/db/client.ts` and the MCP runtime — the ABI rules in AGENTS.md stay untouched.
- The renderer keeps talking the exact same IPC surface (`chat:stream` / `chat:token` / `chat:tool-call` / `chat:done`). Only the engine call site changes.
- Chat messages still land in `chat_threads` / `chat_messages` (SQLite), so the mobile SSE bridge, pop-out window, and PreviewPane keep working with zero UI changes.

## 4. Phased rollout (aggressive — Cordis default, frozen fallback)

### Phase 0 — Stabilize the dependency baseline (DONE 2026-08-19)
- [x] Core tree installs and runs at the coherent **0.1.0-rc.8** snapshot (all 32 deps; `@deepseek-ai/cordis@4.0.1`). See pinned matrix in `package.json`.
- [x] Chat engine swap proven end-to-end (get_active_context → real SQLite → answer).
- [x] Full coding toolset mounts on rc.8: bash, read, write, edit, glob, grep, str_replace_editor, todo_write, exit_plan_mode.
- [x] 5 packages remain unpublished (`dsh-environment`, `dsh-bash-env`, `dsh-tasks`, `dsh-skill-local`, `dsh-cordis`) — none needed for the core/coding stack; revisit when adopting workflows/skills.

### Phase 1 — Cordis default + parity plugins (CURRENT)
- [ ] Flip the engine toggle default to `cordis`; keep built-in as frozen legacy (advanced setting / `CAIRN_ENGINE=builtin` env for rollback only, not developed).
- [ ] `cairn-session` — persist dsh session events → `chat_threads`/`chat_messages` (done; reasoning field captured too — **no separate cairn-reasoning plugin needed** since dsh round-trips reasoning to the model natively via `deriveMessages`).
- [ ] `cairn-usage` — full usage/credit/reasoning mapping → `chat:usage` + `recordLlmUsage` + ContextRing (usage done; add credit recovery).
- [ ] `cairn-subagent` — map dsh subagent events → `chat:subagent*` IPC (parity for `useSubagents`).
- [ ] `cairn-external-tools` — user MCP servers + custom services onto `ctx.tools`.
- [ ] Fix bundle-guard + native-deps-guard (allowlist esprima/@google/genai/koffi) + accept ~5.4mb footprint; verify win32-arm64 packaging.

### Phase 1.5 — Port the CODING AGENT to Cordis (NEXT — the real Phase-2 blocker)

The chat loop is ported. The **coding agent** (`electron/ipc/pi-agent.ts` + `electron/lib/pi-agent-loop.ts`, driven by `runAgentLoop`) is still 100% on the built-in stack and is far richer than chat (plan mode, HITL approvals, doom-loop, retries, compaction, skills, stateful sessions, cwd/bash/fs tools). It CANNOT be deleted until ported. This phase builds `runCordisCodingLoop` + a `cairn-coding` bridge, mirroring the `pi-agent:*` IPC contract exactly (renderer + mobile stay unchanged).

**Contract to preserve (from the audit):** `pi-agent:*` IPC — inbound `prompt/abort/approve-plan/compact-now/set-mode/respond-tool/respond-doom-loop/respond-questions/clear/destroy/preview-prompt/restore-context/is-running`; outbound `token/thought/tools-ready/tool/tool-confirm-required/doom-loop/note-updated/todos/step/usage/retry/compact/compact-result/done/error/plan-note/mode-change/ask-questions/subagent`.

Sub-steps (roughly in order):
- [ ] **2a — Coding toolset mount.** Wire dsh coding tools: `dsh-tool-bash`(+`dsh-bash-local`+`dsh-subprocess-local`+`dsh-shell-env`), `dsh-tool-fs`(+`dsh-fs-local`/`dsh-fs-sandbox`), `dsh-tool-fs-search`, `dsh-tool-str-replace-editor`, `dsh-tool-todo`. Proven to mount on rc.8 in `coding.live.test.ts`. Decide 1:1 map onto Cairn's `read/write/edit/bash/grep/find/ls/todowrite` vs reuse Cairn's coding-tools bodies as registered tools.
- [ ] **2b — cairn-coding bridge plugin.** Map dsh session/tool/turn events → the `pi-agent:*` IPC vocabulary (token/thought/tool/step/usage/note-updated/todos/plan-note/mode-change). Sibling to `cairn-subagent`.
- [ ] **2c — Sessions + persistence.** Keep Cairn's `pi_agent_sessions` metadata + `pi_agent_llm_history` (JSON) + display transcript + `pi_session_todos` (no dsh equivalent for SQLite display/todos). Decide dsh jsonl persistence vs Cairn's `saveLlmHistory`/`getLlmHistory`. Stateful `sessions` Map + `runningLoops` + `is-running` stay Cairn-side (or a long-lived per-session Cordis agent).
- [ ] **2d — Plan mode.** `dsh-plan-mode` for the plan/execute gate + read-only PLAN_MODE_ALLOWED toolset; bridge `set-mode`/`approve-plan`/`plan-note`/`mode-change`; reuse Cairn's plan-note PRD prompt via `cairn-system-prompt`.
- [ ] **2e — Approvals (HITL).** `dsh-user-approval` + `dsh-permission-presets`. Bridge `tool-confirm-required` ⇄ `respond-tool` (+grant session/command) + `autoApprove` bypass. Author the `automation-dev` file-only-no-shell preset.
- [ ] **2f — Doom-loop.** No dsh package — reimplement Cairn's rolling `recentToolCalls` + `toolCallSignature` + `DOOM_LOOP_THRESHOLD=3` as a pre-execute hook; bridge `doom-loop` ⇄ `respond-doom-loop`.
- [ ] **2g — Questions.** `ask_questions` → `pi-agent:ask-questions` ⇄ `respond-questions` (answer string becomes the tool result same turn). `dsh-user-questions` is installed-but-undeclared — adopt it or keep Cairn's interception.
- [ ] **2h — Compaction + retries.** `dsh-compaction-basic` for 80%-context auto-compaction + `/compact` (`compact-now`/`compact`/`compact-result`), or keep Cairn's `buildCompactionTransformer`. Retries via `dsh-llm-retry` → `pi-agent:retry`.
- [ ] **2i — Skills.** `dsh-skill-local` is MISSING (unpublished). Keep Cairn's `discoverSkills`/`renderSkillsXml` + `skill` tool as a `cairn-skills` plugin over the fs.
- [ ] **2j — Sandbox/cwd.** `dsh-fs-sandbox` + `dsh-sandbox-local`/`-policy` scoped to the request `cwd` (`{mode, workspaceRoot}`); preserve the automation-dev traversal restriction.
- [ ] **2k — Missing deps.** Add `dsh-user-questions`, `dsh-attachment` to package.json before relying on them; re-verify guards + win32-arm64 packaging.
- [ ] Gate behind `CAIRN_ENGINE` like chat; live-test each capability before flipping the coding default.

### Phase 2 — Delete the old loops (parity gate met)
- [ ] Once BOTH chat AND coding parity are proven in production, **delete** `chat-loop.ts`, `chat-subagent-loop.ts`, `pi-agent-loop.ts`, and the toggle.
- [ ] Also port the small remaining built-in callers: `user-style-handlers.ts` (`runToolLoop`) and the automation heartbeat runner.
- [ ] Retire the old loops and their IPC handlers.

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