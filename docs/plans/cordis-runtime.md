# Cairn Cordis Runtime — Rollout Plan

Status: **Active — Phase 1 DONE; Phase 1.5 (coding agent) in progress** · Updated: 2026-08-19
Owner: Cairn maintainer
Related note: *DeepSeek Harness (dsh) integration analysis* (Cairn project)
Branch: `feat/cordis-runtime` · Latest: `7f9076a6`

> **Session handoff (read first):** See §8 for the current status, exactly what's
> done vs pending, how to run the live tests, and the next concrete step.

## 1. Goal

Make the **Cairn Cordis runtime the single, default engine** behind Cairn's chat + agent surfaces, so Cairn stops maintaining its own agent loops entirely. Cairn boots its own Cordis tree **in-process in Electron main**, consumes the dsh stack (`dsh-agent-loop` orchestrator + `dsh-llm-pi-ai` model transport + dsh capability plugins for plan-mode/bash/fs/subagents/approvals/sandbox), and writes **small `cairn-*` plugins** for every Cairn-specific concern — each parity gap is a plugin, not a fork.

**Strategy decision (2026-08-19):** Cordis is **default**. The built-in loops (`chat-loop.ts`, `pi-agent-loop.ts`, `chat-subagent-loop.ts`) become **frozen legacy** — reachable via an advanced setting/env var for rollback only, never developed in parallel. Delete them + the toggle once parity lands.

**UI/Client strategy decision (2026-08-19, validated by repo investigation):** dsh is NOT host-only — it ships a **full web GUI** (`apps/web` + `@deepseek-ai/dsh-client-*`, composed as the `dsh-web-app` bundle) with a **slot-based plugin-UI system** (`ui-slots`, `tool.call.toolview`, `conversation.chat.node`). The design explicitly anticipates an **Electron consumer** (architecture note names a future `AbstractApiClient.doFetch` IPC subclass; `dsh-host-webserver` README: "Electron loads dist over file:// and carries fetch over an IPC bridge"). The host web stack (webserver + apiproxy + connection + frontend-static) runs **in-process on the same shared Cordis ctx** as the agent loop — no separate dsh CLI/profile process required (profiles are only packaging).

**Consequence for plugin-UI:** keeping Cairn's bespoke `pi-agent:*`/`chat:*` IPC + own React frontend means third-party dsh plugins would contribute **backend only, no UI**. The long-term direction is to **adopt dsh's client/UI layer** via bridge plugins: a Cairn `root`-occupying layout plugin (to host Cairn's notes/board/graph/insights alongside the dsh conversation), Cairn brand/theme occupants, **keyed `tool.call.toolview` views** for Cairn's data tools (a designed extension point), and a **persistence bridge** (dsh session jsonl ↔ Cairn SQLite — the hardest seam, since dsh's "model-visible ⟺ logged" invariant must hold). The current bespoke IPC bridge is a **stepping stone** to prove the host side (chat + coding agent) works end-to-end; replacing it with dsh's client/connection layer is the Phase-3 goal. See §9.

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

### Phase 1 — Cordis default + parity plugins (DONE ✅)
- [x] Flip the engine default to `cordis`; built-in is frozen legacy (`CAIRN_ENGINE=builtin` env, or the `localllm` provider). (`cd0d0882`)
- [x] `cairn-session` — persist dsh session events → `chat_threads`/`chat_messages` incl. reasoning (**no cairn-reasoning plugin** — dsh round-trips reasoning natively). (`7926d14e`)
- [x] `cairn-usage` — usage → `chat:usage` + `recordLlmUsage`. (credit recovery still TODO — minor)
- [x] `cairn-subagent` — dsh subagent events → `chat:subagent*` IPC. (`b452b484`; thinking/brief split fixed `f08b125d`)
- [x] `cairn-external-tools` — user MCP servers + custom services onto `ctx.tools`. (`f4e48739`)
- [x] Fix bundle-guard + native-deps-guard + footprint. (`cd0d0882`)
- [x] **Bonus fixes (post-flip):** `import.meta.url` CJS-bundling crash (`7e16808c`); system-prompt + history injection + live token/reasoning streaming (`d1d6c2bf`); reasoning via completions (`636eac1e`); system-prompt as a plugin (`3259f35b`); **auto responses/completions probe-and-cache + runtime fallback** (`4dee51f4`).

### Phase 1.5 — Port the CODING AGENT to Cordis (IN PROGRESS — the real Phase-2 blocker)

The chat loop is ported. The **coding agent** (`electron/ipc/pi-agent.ts` + `electron/lib/pi-agent-loop.ts`, driven by `runAgentLoop`) is still 100% on the built-in stack and is far richer than chat (plan mode, HITL approvals, doom-loop, retries, compaction, skills, stateful sessions, cwd/bash/fs tools). It CANNOT be deleted until ported. This phase builds `runCordisCodingLoop` + a `cairn-coding` bridge, mirroring the `pi-agent:*` IPC contract exactly (renderer + mobile stay unchanged).

**Contract to preserve (from the audit):** `pi-agent:*` IPC — inbound `prompt/abort/approve-plan/compact-now/set-mode/respond-tool/respond-doom-loop/respond-questions/clear/destroy/preview-prompt/restore-context/is-running`; outbound `token/thought/tools-ready/tool/tool-confirm-required/doom-loop/note-updated/todos/step/usage/retry/compact/compact-result/done/error/plan-note/mode-change/ask-questions/subagent`.

Sub-steps (roughly in order):
- [x] **2a — Coding toolset mount.** `mountCodingStack` (`electron/cordis/cordis-coding-tools.ts`) mounts the dsh coding stack in dsh-base order; live-verified (bash/read/write/edit/glob/grep/str_replace_editor/todo_write/exit_plan_mode). (`ec8d793c`)
- [x] **2b — cairn-coding bridge plugin + loop scaffold.** `cairnCodingPlugin` (in `cairn-plugins.ts`) maps the MAIN coding session's dsh `session/event` → the `pi-agent:*` IPC vocabulary (token/thought/tool pending+end/tools-ready/usage/step/done/error, plus note-updated/todos/plan-note side effects). `runCordisCodingLoop` (`run-cordis-coding.ts`) mounts the coding stack + Cairn tools + questions bridge, creates a dsh agent, drives one turn, emits through the plugin, and settles the terminal promise on done/error. **Live-verified** (`coding-agent.live.test.ts`): writes a file via the dsh tools and emits token/thought/tool/usage/done end-to-end. Wiring into `pi-agent:prompt` + flipping the default is the FINAL gated step below (after 2c–2k parity). **← built; next is 2c sessions/persistence.**
- [x] **2c — Sessions + persistence via dsh jsonl.** Adopted `dsh-session-persistence-jsonl` (mounted on the shared context; root = `<userData>/sessions`, set via `setSessionRoot` from Electron main). The coding loop uses a **stable dsh session id = the caller's pi sessionId** and **resumes** the persisted session on each prompt (detect existence via `ctx.sessionPersistence.inspect`, then `ctx.agents.resume` vs `ctx.agentLoop.createAgent`); the agent handle is disposed at turn end so its session detaches from the live registry while the jsonl log persists. **Session/chat transcripts live in dsh jsonl, NOT Cairn's SQLite** (the DB is for MCP/tool access only) — no `pi_agent_llm_history`/`pi_agent_sessions`/`chat_threads` writes on the Cordis path. `pi_session_todos` stays in the DB (todo dock reads it). Live-verified: two turns on one sessionId — the model recalls a fact from turn 1 in turn 2 (jsonl resume), with no DB session tables present. Bundle-guard: `node:timers/promises` added to NODE_BUILTINS (used by the jsonl backend).
- [x] **2d — Plan mode.** `cairnPlanModePlugin` (in `cairn-plugins.ts`) registers a `tools/pre-execute` guard that DENIES mutating tools while plan mode is active, mirroring Cairn's builtin `PLAN_MODE_ALLOWED` (read-only coding tools + Cairn read tools + `ensure_note` PRD write + `exit_plan_mode`/`plan` + `ask_questions`/`skill`). `runCordisCodingLoop` sets the dsh plan state via `ctx.planMode.set(agent, mode==="plan")` (logged + persisted across resume) so the plan policy section renders + `exit_plan_mode` works. `pi-agent:plan-note` flows via `cairnCodingPlugin` when `ensure_note` succeeds in plan mode. Live-verified: in plan mode the model CANNOT write/edit/bash (denied), the file isn't created, and it produces a plan. (`set-mode`/`approve-plan` IPC wiring stays for the final gated step.)
- [x] **2e — Approvals (HITL).** Mounted `dsh-user-approval` (`ctx.approval`, policy `'ask'`) on the shared context. `cairnApprovalPlugin` (per-turn, no-op when `autoApprove`): (1) a `tools/pre-execute` handler returns `{kind:'ask'}` for any non-`APPROVAL_SAFE` (mutating) tool, routing it to the approval seam; (2) an `approval/request` answerer emits `pi-agent:tool-confirm-required` and blocks on `pi-agent:respond-tool`, mapping the decision to `allowed-once`/`rejected`/`cancelled`. A `grant:'session'` is remembered so the same tool isn't re-prompted for the turn. `runCordisCodingLoop` gained `autoApprove` + an `approvals` adapter (forced on when no adapter supplied — never block on an unanswerable prompt). Live-verified: a write tool triggers `tool-confirm-required`, the simulated renderer approves, and the file is created. (`dsh-permission-presets` + `automation-dev` file-only preset deferred — the read-only guard already covers automation-dev via plan-mode-style gating; presets can layer later.)
- [x] **2f — Doom-loop.** `cairnDoomLoopPlugin` (`cairn-plugins.ts`) reuses the builtin `toolCallSignature` + `DOOM_LOOP_THRESHOLD=3`. A `tools/pre-execute` guard keeps a rolling window of signatures; when the last `THRESHOLD-1` calls all match the current signature, it emits `pi-agent:doom-loop` + blocks on `pi-agent:respond-doom-loop` (allow → run + stop re-pausing; deny → `{kind:'deny'}`). Keyed `${sessionId}:${signature}`. `runCordisCodingLoop` gained a `doomLoop` adapter. Unit-tested (`doom-loop.test.ts`): trips on 3rd identical call + denies; approve sticks; different tools/args don't trip.
- [x] **2g — Questions.** DONE (in the CHAT path first, reusable by coding). Adopted the **`dsh-user-questions`** seam (`ctx.userQuestions`) + `cairnQuestionsPlugin` provider; `ask_questions` tool BLOCKS via `ctx.userQuestions.ask()` and returns answers same-turn. `dsh-tool-ask-user` (model tool) is unpublished, so Cairn keeps its own `ask_questions` tool. Cordis-only description override tells the model the tool blocks+returns (else it wrote "fill the form" and stopped). Renderer: `chat:answer-questions` IPC + `answerQuestions()` + `QuestionForm.onSubmitStructured`; form must NOT be gated on `isLoading` (blocking pauses mid-turn). (`83af0d51`, `bb63771a`, `7f9076a6`) — the coding agent still needs to WIRE this seam into `runCordisCodingLoop` (2b/2e work).
- [ ] **2h — Compaction + retries.** `dsh-compaction-basic` for 80%-context auto-compaction + `/compact` (`compact-now`/`compact`/`compact-result`), or keep Cairn's `buildCompactionTransformer`. Retries via `dsh-llm-retry` → `pi-agent:retry`.
- [ ] **2i — Skills.** `dsh-skill-local` is MISSING (unpublished). Keep Cairn's `discoverSkills`/`renderSkillsXml` + `skill` tool as a `cairn-skills` plugin over the fs.
- [ ] **2j — Sandbox/cwd.** `dsh-fs-sandbox` + `dsh-sandbox-local`/`-policy` scoped to the request `cwd` (`{mode, workspaceRoot}`); preserve the automation-dev traversal restriction.
- [ ] **2k — Missing deps.** `dsh-user-questions` ADDED to package.json (`83af0d51`). Still add `dsh-attachment` before relying on it; re-verify guards + win32-arm64 packaging.
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
- 2026-08-19: Cordis is the DEFAULT engine; built-in loops frozen (env `CAIRN_ENGINE=builtin` or `localllm` provider only). Chat path fully ported + live-verified.
- 2026-08-19: Wire protocol is auto-selected per endpoint (reuse `electron/lib/llm-transport.ts` `resolveTransport` probe-and-cache + `markCompletionsOnly` runtime fallback) — no hardcoded/persisted protocol.
- 2026-08-19: `dsh-llm-pi-ai` is the adapter = a thin wrapper over `@earendil-works/pi-ai` (a 3rd-party unified multi-provider LLM client). It sits BELOW the standard `dsh-agent`/`dsh-agent-loop` — it is NOT an agent. No `dsh-pi-agent` package exists.
- 2026-08-19: Questions adopt the `dsh-user-questions` SEAM (blocking, same-turn) but keep Cairn's `ask_questions` TOOL because the model-facing `dsh-tool-ask-user` package is unpublished.
- 2026-08-19: **Client/UI adoption.** dsh ships a full web GUI + slot-based plugin-UI (`apps/web`, `@deepseek-ai/dsh-client-*`, `dsh-web-app` bundle) and explicitly anticipates an Electron consumer (IPC `AbstractApiClient.doFetch`). The host web stack runs in-process on the shared Cordis ctx. Our bespoke IPC bridge is a valid stepping stone (proves the host side) but forfeits plugin-UI. Direction: adopt dsh's client/UI layer via bridge plugins (Cairn root layout, brand/theme, keyed `tool.call.toolview` views, persistence bridge) — see §9. Host-only IPC bridge is NOT the end-state.

## 8. Session handoff — resume here

**Branch:** `feat/cordis-runtime` · **Latest commit:** `156f694b` · tree clean.

**Where we are:** Phase 1 (chat) is DONE and shipping as the default engine. Phase 1.5 (port the coding agent) is underway: **2a** (coding toolset), **2g** (questions), **2b** (cairn-coding bridge + runCordisCodingLoop), **2c** (dsh jsonl persistence + resume — no DB session storage), **2d** (plan-mode read-only gate), **2e** (HITL approvals via dsh-user-approval), **2f** (doom-loop guard) — all verified. **Next: 2h** — compaction + retries.

**Key files (all under `electron/cordis/`):**
- `run-cordis-loop.ts` — the chat loop (`runCordisLoop`). Boots the shared Cordis tree in `getContext()`; mounts pi-ai adapter (`ensurePiAiAdapter`, protocol from `resolveTransport`); mounts `cairn-*` plugins per call; `runTurn()` with the responses→completions runtime fallback; live token/reasoning streaming via a `session/event` listener scoped to `currentAttemptSessionId`.
- `cairn-plugins.ts` — `cairnDbPlugin` (owns Database on `CAIRN_DB`), `cairnSessionPlugin`, `cairnUsagePlugin`, `cairnSubagentPlugin` (child `origin:'subagent'` → `chat:subagent*`; text/reasoning kept disjoint), `cairnSystemPromptPlugin` (`inject:['systemPrompt']`), `cairnQuestionsPlugin` (`inject:['userQuestions']`).
- `cairn-tools.ts` — `registerCairnTools` (~56 data tools via `buildCairnTool` → `executeTool`; **ask_questions overridden** to `ctx.userQuestions.ask()` + a Cordis-only description), `registerExternalCairnTools` (user MCP/services).
- `cordis-coding-tools.ts` — `mountCodingStack(ctx,{cwd})` — the dsh coding capability stack (step 2a).
- Live tests (gated `CORDIS_LIVE=1`, need `CORDIS_DUMMY_KEY=local` + the bridge at `localhost:3042`): `pi.live.test.ts` (chat+history+streaming), `subagent.live.test.ts` (thinking/brief split), `questions.live.test.ts` (blocking same-turn), `coding.live.test.ts` (coding stack).

**How to run:**
- Full electron suite: `npx vitest run electron` (85+ files, ~1151 tests, must stay green).
- Live Cordis tests: `CORDIS_LIVE=1 CORDIS_DUMMY_KEY=local npx vitest run electron/cordis/<file> --testTimeout=90000` (needs the Rork bridge running at `http://localhost:3042/v1`).
- Rebuild bundle after Electron changes: `npm run compile`; type-check: `npm run type-check:all` (ignore `scratch/dsh-repo/*` errors — gitignored clone).

**Gotchas / hard-won facts:**
- dsh capability seams (`ctx.systemPrompt`, `ctx.userQuestions`, …) are gated: a plugin must set `plugin.inject = ["<seam>"]` or you get "cannot get property X without inject".
- dsh throws on duplicate prompt-section names → `cairnSystemPromptPlugin` uses a unique `cairn:system:<id>` per mount.
- `cairnDbPlugin` is idempotent (skip `provide` if `CAIRN_DB` present) — its disposer is async, so back-to-back turns can re-mount before teardown.
- esbuild is stricter than tsc — avoid deeply-nested inline function-type casts (extract to a named interface) or you get a PARSE_ERROR at bundle time only.
- `import.meta.url` in bundled ESM deps is handled by the banner+define in `package.json`/`scripts/build.js` (`globalThis.__cairnImportMetaUrl`) — don't remove it.
- The renderer question form must NOT be gated on `isLoading` (a blocking ask_questions pauses the turn mid-flight).
- The `ask_questions` tool needs the Cordis-only description telling the model it BLOCKS and RETURNS answers, else the model writes a "fill in the form" sign-off and stops.

**Next concrete step (2h):** compaction + retries. Options: (a) mount `dsh-compaction-basic` for 80%-context auto-compaction + a `/compact` command, bridging `pi-agent:compact`/`compact-result` and `pi-agent:compact-now`; or (b) keep Cairn's `buildCompactionTransformer` (`electron/lib/compaction.ts`) — but dsh owns the session log now, so the dsh compaction engine is the natural fit. Retries: mount `dsh-llm-retry` and bridge its `llm/retry` status → `pi-agent:retry`. Then 2i skills (`cairn-skills` — `discoverSkills`/`renderSkillsXml` + `skill` tool over the fs), 2j sandbox/cwd (`dsh-fs-sandbox` already in mountCodingStack — verify traversal restriction + automation-dev), 2k deps (`dsh-attachment`, re-verify guards + win32-arm64). Then the FINAL integration: wire `runCordisCodingLoop` into `electron/ipc/pi-agent.ts` behind `CAIRN_ENGINE` — `pi-agent:prompt`/`approve-plan` call the loop; `respond-tool`/`respond-questions`/`respond-doom-loop`/`set-mode` resolve the per-turn pending maps; `sessions`/`runningLoops`/`is-running` stay Cairn-side (builtin path untouched). Only then flip the coding default. Loop = `electron/cordis/run-cordis-coding.ts`; plugins = `cairn-plugins.ts` (cairnCoding/PlanMode/Approval/DoomLoop/Questions); live proof = `electron/cordis/coding-agent.live.test.ts` (4 tests) + `doom-loop.test.ts` (unit).

## 9. Adopting the dsh client/UI layer (Phase 3 — validated, not yet started)

**Discovery (2026-08-19):** dsh is NOT host-only. It ships a full web GUI + slot-based plugin-UI system. Our bespoke IPC bridge is a valid **stepping stone** (proves the host side) but forfeits plugin-UI. Repo investigation (`scratch/dsh-repo`) confirmed adoption is feasible + design-sanctioned.

**Feasibility findings (from explore agent on `scratch/dsh-repo`):**
- **In-process host:** webserver (`dsh-host-webserver`, plain `node:http`), apiproxy (`dsh-host-apiproxy`), connection (`dsh-client-connection`), frontend-static all run **in-process on the same shared Cordis ctx** as the agent loop. No separate dsh CLI/profile process needed (profiles = packaging only). Engine `node ^22.19 || >=24` (Electron 43 ships Node 22 ✓).
- **Electron-anticipating:** architecture note `2026-07-19-gui-layering-and-rpc-protocol.md` explicitly names a future Electron `AbstractApiClient.doFetch` IPC subclass; `dsh-host-webserver` README: "Electron loads dist over file:// and carries fetch over an IPC bridge." No service workers / PWA / cross-origin blockers.
- **Two host options:** (A) run in-process server, `loadURL('http://127.0.0.1:<port>')` — simplest, keeps WebApiClient + WebSocket unchanged; (B) `file://` + IPC `doFetch` carrier — the design's preferred path, bigger lift (only `WebApiClient` is shipped as a browser carrier today; the in-process carrier is a host test seam).
- **White-label:** `ui-brand-official` fills brand slots only under `DSH_CLIENT_BUILD_PROFILE='official'` — a deployment/brand plugin can occupy the same slots. `ui-theme` uses `--dsw-*` tokens (≠ Cairn's `--*` tokens; needs a mapping layer if both coexist in one DOM).
- **Layout is all-or-nothing:** `ui-layout` occupies the `root` slot with a fixed 3-column AppFrame (sidebar|conversation|details). To host Cairn's notes/board/graph/insights as peers of the conversation, write a **Cairn `root`-occupying layout plugin** (replace `ui-layout`/`ui-sidebar`) — architecturally sanctioned, real work. Or add Cairn views as `conversation.view` tabs inside the conversation column.
- **Cairn data tools get UI for free:** `tool.call.toolview` is a designed keyed-slot extension point — a client plugin registers `key:'<toolName>'` React views for get_note/ensure_note/board tools etc. (e.g. `ui-skill` registers the `skill` view). Unregistered tools fall back to a generic card.
- **Persistence = hardest seam:** dsh session jsonl (append-only SessionEvent log) vs Cairn SQLite notes/boards are separate stores. Bridge = Cairn tools (in shared host ctx) read/write SQLite while logging model-visible results to the dsh session log (dsh invariant: "model-visible ⟺ logged").

**Phase-3 bridge-plugin workstream (deferred until Phase 2 parity done):**
1. Boot the dsh host web stack in Electron main on the shared ctx (option A first).
2. `cairn-root-layout` client plugin — occupy `root` slot, host the dsh conversation view alongside Cairn's nav/views.
3. `cairn-brand` / `cairn-theme` client plugins — brand occupants + token mapping.
4. `cairn-toolview-*` client plugins — keyed `tool.call.toolview` views for Cairn's data tools.
5. `cairn-persistence-bridge` — reconcile dsh session jsonl with Cairn SQLite (threads/notes/boards).
6. Remove the bespoke `pi-agent:*`/`chat:*` IPC bridge once dsh's connection layer carries the same events.

**Decision log:** see §7 for the 2026-08-19 client-adoption entry.