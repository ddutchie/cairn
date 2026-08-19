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
- [x] **2h — Compaction + retries.** Mounted three services on the shared context (`getContext`, so chat + coding share them): `dsh-token-meter` (request/surface pressure), `dsh-compaction-basic` (`{auto:true, thresholdRatio:0.8}` → auto-compacts between steps at 80% of the model window + on provider context-overflow, replacing the compacted span with one summary node — the dsh-native replacement for Cairn's `buildCompactionTransformer`, and the natural fit since dsh now owns the jsonl session log), and `dsh-llm-retry` (executes the provider-owned `retryPolicy` on the agent-loop request-recovery seam). Added a `retryPolicy` (`normal`, maxRetries 5, exp backoff 500ms→10s, jitter 0.1) to the `cairn` pi-ai provider registration so retries actually fire. `cairnCodingPlugin` bridges the durable session events → the exact builtin renderer contract: `llm/retry`→`pi-agent:retry {attempt(1-based),maxRetries,delayMs,error}`; `compaction/start`→`pi-agent:compact {status:'start'}`; `compaction/summary` captures the summary text + `shadowedSeqs.length`; `compaction/end`→`pi-agent:compact {status:'end',auto:true}` + `pi-agent:compact-result {messageCount,summary}` (suppressed when the close carries an `error`). Unit-tested (`compaction-retry.test.ts`, 6 tests, no live model): retry mapping incl. code fallback, start/summary/end sequencing, failed-close suppression, block-array summary extraction. Live coding suite still green (all 4 pass individually). Manual `/compact` (`ctx.compaction.compactNow(agent)`) deferred to the final `pi-agent.ts` wiring since it needs the live agent handle.
- [x] **2i — Skills.** `dsh-skill-local` is unpublished, so Cairn keeps its own fs-based skills (engine-agnostic already). `registerSkillTool(ctx, skills)` (in `cairn-tools.ts`) registers a Cordis `skill` tool via `defineTool` that calls `loadSkill` and returns the SKILL.md body + bundled-resource paths — the Cordis equivalent of `coding-tools/skill.ts`. `runCordisCodingLoop` now calls `discoverCodingSkills(cwd)` once per turn, appends `renderSkillsXml(...)` (`<available_skills>`, name+description only) to the coding system prompt via `cairnSystemPromptPlugin`, and registers the tool (no-op when no skills). `skill` is already in APPROVAL_SAFE + PLAN_MODE_ALLOWED. Live-verified (`coding-agent.live.test.ts`, test 5): a project-local `.cairn/skills/secret-greeter/SKILL.md` under cwd surfaces in the prompt, the model calls `skill` (pending→end), and follows the loaded body exactly (replies `BANANA-PROTOCOL-7`).
- [x] **2j — Sandbox/cwd.** The sandbox stack was already mounted in `mountCodingStack` (`dsh-sandbox-local` → `dsh-sandbox-policy {mode, workspaceRoot:cwd}` → `dsh-fs-sandbox {cwd}` → `dsh-fs-observation-policy`) but hardcoded to `danger-full-access`. Threaded a `sandboxMode` option (`read-only` | `workspace-write` | `danger-full-access`) through `runCordisCodingLoop` → `mountCodingStack`, and **changed the default to `workspace-write`** so a coding agent cannot escape the project root. Confirmed dsh's semantics from source: `workspace-write` permits mutations under the workspace root **plus platform temp areas** (the Seatbelt writable-root set), `read-only` denies all mutation, `danger-full-access` is unfenced; a denial throws `FS_SANDBOX_DENIED`. Live-verified (`coding-agent.live.test.ts` tests 6–7): with `workspace-write`, a write to a path **outside cwd and outside temp** (a sibling dir under HOME) is denied (file not created), while a write **inside cwd** succeeds. The HITL approval test was hardened to assert on the deterministic `pi-agent:tool` end `ok` signal rather than a racy `fs.existsSync`. (Automation-dev restriction: callers that need file-only-no-shell pass `sandboxMode:"read-only"` or the plan-mode gate; the per-caller preset is chosen at the final `pi-agent.ts` wiring.)
- [x] **2k — Missing deps.** Audited every `@deepseek-ai/dsh-*` import in `electron/cordis/*` against `package.json`: **all declared** (incl. the 2h/2e/2g additions `dsh-token-meter`, `dsh-compaction-basic`, `dsh-llm-retry`, `dsh-user-approval`, `dsh-user-questions`). `npm run compile` builds all four bundles cleanly with the new deps; `bundle-guard.test.ts` (12 tests) green — every node builtin the new deps pull in (`node:timers/promises`, etc.) is already in `NODE_BUILTINS`. win32-arm64 packaging remains a release/CI verification (can't exercise on darwin) but introduces no new native addon beyond better-sqlite3/onnxruntime, which are already arch-handled. **NOTE:** `dsh-attachment` was initially deferred as "unused" — that was wrong (see 2l): both Cordis loops silently drop `req.images`, so image attachments are a real regression vs the builtin agent. `dsh-attachment` is required and is added in 2l.
- [x] **2l — Attachments.** Both builtin loops support image + PDF attachments; both Cordis loops were silently dropping `req.images` (text-only `createUserMessage`). Fixed: (1) implemented a concrete `CairnAttachmentStore extends AttachmentStore` (`cairn-attachment-store.ts`) — dsh ships only the abstract class. In-process, content-addressed (sha256, dedupes), with a dependency-free raster-header dimension decoder for PNG/JPEG/WebP/GIF (sharp is a stub in this repo, so we parse IHDR/SOF/RIFF/GIF headers directly — no native dep). Mounted on the shared context in `getContext`; the pi-ai plugin already wires `resolveAttachments: () => ctx.get("attachments")`, so images round-trip automatically. (2) Added `defaultInput: ["text","image"]` to the `cairn` pi-ai provider so the route declares image capability (pi-ai refuses images on a text-only route). (3) `buildCordisUserContent(ctx, text, images)` converts `req.images` → dsh `ImageBlock`s via `store.saveImage`; used by BOTH loops when building the followup. PDFs degrade gracefully to a text note ("PDF attached, not yet supported on this engine — ask the user to paste text") since dsh's `ContentBlock` union has no document block and text-extraction would pull pdfjs into the Electron main bundle — full PDF passthrough is a tracked follow-up. Unit-tested (`cairn-attachment-store.test.ts`, 10: dimension decode, save/read round-trip, dedupe, type-mismatch, not-found, block builder incl. PDF-degrade + no-store fallback + unparseable-omit). Live-verified (`coding-agent.live.test.ts` test 8): a real 8×8 red PNG attached to a coding turn round-trips the store → ImageBlock → pi-ai wire and the model answers `"red"`. Also hardened the 2j-inside + 2e-approval live tests to assert on the deterministic `pi-agent:tool` end `ok` signal (was intermittently model-flaky).
- [x] **FINAL wiring — DONE.** `runSession` (the shared runner both `pi-agent:prompt` and `pi-agent:approve-plan` call) now branches on `CAIRN_ENGINE`: `cordis` (default) → `runCordisCodingSession` → `runCordisCodingLoop`; `builtin` → the frozen `runAgentLoop`. Both entry points pass a `CordisTurnPayload` (message + attachments + projectId/workspaceId + autoApprove + `sandboxMode:"workspace-write"`). Module-level pending maps (`cordisPendingApprovals` / `cordisPendingDoomLoop` / `cordisPendingQuestions`) are populated by the loop's adapters and resolved by the existing `pi-agent:respond-tool` / `respond-doom-loop` / `respond-questions` handlers (each checks the cordis map first, then falls back to the builtin map). Streamed deltas run through the same `createDeltaBatcher`; `plan-note` persists the PRD id; `runningLoops`/`is-running`/`abort` stay Cairn-side (the loop takes `session.abortCtrl.signal`). Questions channel: chat emits `chat:tool-call`; the coding path passes an `emitQuestions` strategy so `cairnQuestionsPlugin` emits `pi-agent:ask-questions {sessionId,callId,questions}` (the coding renderer's channel). automation-dev keeps `workspace-write` (its no-shell restriction comes from the file-only persona toolset, not the fs sandbox). **The coding default is flipped** — cordis is default; `CAIRN_ENGINE=builtin` is the escape hatch (same as chat). Type-check + full electron suite green (90 files / 1178); bundle builds; all 8 live coding capabilities pass in isolation.

### Phase 2 — Delete the old loops (parity gate met)

> **Goal:** remove every line of the frozen builtin agent loop so the Cordis path is the only path. No dead code, no dual pending-maps, no `CAIRN_ENGINE` toggle, no `pi_agent_llm_history` table writes. The app ships smaller, the IPC surface is engine-agnostic, and the next contributor never has to ask "which loop am I in?"

#### Gating — do not start until the flipped default has soaked

| Gate | How to verify |
|---|---|
| Chat + coding Cordis defaults have shipped one full release (`v2.7.7`) with no `CAIRN_ENGINE=builtin` rollback | Release notes + support channel silence |
| No P1/P2 filed against Cordis streaming, approvals, doom-loop, skills, sandbox, attachments, compaction, or session resume | GitHub issues filtered `label:cordis` |
| Live suite (`coding-agent.live.test.ts` 8 tests) passes on CI with `CORDIS_LIVE=1` for 3 consecutive runs | CI workflow `cordis-live` |
| `pi_agent_llm_history` row count stops growing in the wild (jsonl is the source of truth) | Telemetry or manual DB inspection |

If any gate fails → fix on Cordis, do **not** re-freeze the builtin as the default. `CAIRN_ENGINE=builtin` stays as the escape hatch until Phase 2 deletes it.

#### 2a — Deprecate (soft, no deletions — one PR, ~1 day)

Announce the builtin as deprecated so the toggle's removal is not a surprise.

- [ ] Add a `console.warn("[pi-agent] builtin engine is deprecated and will be removed — set CAIRN_ENGINE=builtin only for rollback")` at the top of the builtin branch in `electron/ipc/pi-agent.ts:179` and `electron/ipc/chat.ts:369`. Guard it with `process.env.CAIRN_ENGINE === "builtin"` so Cordis users never see it.
- [ ] Update `electron/lib/config-cache.ts:28` docstring from `/** Chat/agent engine: "builtin" (default, …) or "cordis" */` to `/** @deprecated — engine is now always cordis; this field is ignored. Remove in Phase 2. */`.
- [ ] Add a one-line note to `changelogs/vNEXT.md` "Deprecated: `CAIRN_ENGINE=builtin` fallback — will be removed next release."
- [ ] No file deletions in this step — the toggle still works, but every builtin entry now self-identifies as deprecated.

#### 2b — Port the last two builtin callers (one PR, ~2 days)

These are the only production callers that still import `runToolLoop` directly. Port them **before** deleting the loop files so the tree stays green at every commit.

| Caller | Current import | Cordis replacement | Notes |
|---|---|---|---|
| `electron/ipc/user-style-handlers.ts:21` `runToolLoop` | `user-style:generateStream` (Settings → Writing Style wizard) | `runCordisLoop` — small read-only wrapper (`autoApprove:true`, no sandbox, `toolsOverride` = `WRITING_STYLE_TOOLS` from the same file). Map `onToken/onUsage/emitToolCall` → the existing `user-style:*` IPC events. | Reuse the chat Cordis loop, not the coding one — it's a data-only task |
| `electron/lib/heartbeat-runner.ts:23` `runToolLoop` | `runAutomation()` (scheduled automations) | `runCordisCodingLoop({ sandboxMode:"workspace-write", autoApprove:true })` with `makeApprovalGate` + `runScript/writeRunFile/deliverFile` bridged as extra tools. Heartbeat's file-only persona already excludes shell, so `workspace-write` is correct. | Keep the `automation:run` streaming + incremental `run-log.json` + `ARTIFACT_TOOLS` collection |

After both ports pass `npm run type-check:all` + `npx vitest run electron` + a manual `user-style:generateStream` + `runAutomation` smoke test, the only remaining `runToolLoop`/`runAgentLoop` imports are in `chat.ts:17` and `pi-agent.ts:22` (the fallback branches) and in test files.

#### 2c — Collapse the dual paths + delete the frozen files (one PR, ~2 days — the big delete)

**Order matters** — collapse the branches first so the deletions have no dangling imports.

1. **Collapse `electron/ipc/chat.ts`** — delete the `const engine = …CAIRN_ENGINE…` branch at `chat.ts:369`, the `import { runToolLoop } from "../lib/chat-loop"` at `chat.ts:17`, the `import { runDispatchLoop }` at `chat.ts:301`, and the entire builtin fallback block `chat.ts:444-471` (`let loopResult … await runToolLoop(…)`). The Cordis `if (provider !== "localllm") { const { runCordisLoop } … }` block becomes unconditional (keep the `localllm` early-return). The dynamic `import("../lib/compaction").generateSummary` at `chat.ts:106` inside `chat:compactThread` stays — it's a one-shot thread summariser, not the agent loop — or replace it with the Cordis summariser if desired.

2. **Collapse `electron/ipc/pi-agent.ts`** — delete `import { runAgentLoop, pendingApprovals, … } from "../lib/pi-agent-loop"` at `pi-agent.ts:22`, `import { buildCompactionTransformer, compactNow } from "../lib/compaction"` at `pi-agent.ts:23`, the `CAIRN_ENGINE` branch at `pi-agent.ts:179-180`, the builtin body `pi-agent.ts:184-269` (`runningLoops.add → buildCompactionTransformer → runAgentLoop → onDone/onError`), and the builtin `pi-agent:compact-now` body at `pi-agent.ts:711 compactNow(…)`. Keep `runCordisCodingSession` and make it the sole body of `runSession`. Collapse the three `respond-*` handlers at `pi-agent.ts:739-789` to check only `cordisPending*` (delete the `pendingApprovals/DoomLoop/QuestionAnswers` fallback). Delete `cordisPending*` → rename to `pending*` since there is only one map now. Inline `toolCallSignature`/`DOOM_LOOP_THRESHOLD` from `pi-agent-loop.ts` into `electron/cordis/cairn-plugins.ts:26` (or `electron/cordis/cairn-attachment-store.ts` constants file) so `cairnDoomLoopPlugin` no longer imports from the deleted file.

3. **Remove the `CAIRN_ENGINE` toggle itself** — delete `engine?: "builtin"|"cordis"` from `electron/lib/config-cache.ts:28-29` and the `configRecord.engine === "cordis"||"builtin"` handling at `config-cache.ts:160`. Grep for remaining `CAIRN_ENGINE` refs — only `changelogs/v2.7.7.md:5` ("`CAIRN_ENGINE=builtin` fallback") and `scripts/features.config.js:239` mention it as docs; leave the docs, delete the runtime check.

4. **Delete the frozen source files** (now with zero importers):
   ```
   electron/lib/chat-loop.ts                        (~657 L)
   electron/lib/chat-subagent-loop.ts               (~756 L)
   electron/lib/pi-agent-loop.ts                    (~1300 L)
   electron/lib/compaction.ts                       (~387 L)  # builtin; Cordis uses dsh-compaction-basic
   electron/lib/coding-tools/subagent.ts            (spawn_subagent via runAgentLoop)
   ```

5. **Retire builtin-only tests** (keep shared + Cordis proofs):
   ```
   electron/lib/pi-agent-loop.test.ts               # runAgentLoop SSE/tool/approval/doom-loop/compaction
   electron/lib/pi-agent-loop-tools.test.ts         # getAllToolDefs persona filtering
   electron/lib/chat-loop-truncation.test.ts        # runToolLoop length guard
   electron/lib/chat-agent-benchmark.test.ts        # runToolLoop vs runDispatchLoop bench
   electron/lib/chat-write-recovery-benchmark.test.ts
   electron/lib/chat-quality-scorer.test.ts         # scores via runToolLoop
   electron/lib/chat-subagent-stream.test.ts        # subagent streaming (builtin)
   electron/lib/coding-tools/subagent.test.ts       # nested runAgentLoop
   electron/lib/heartbeat-runner.test.ts            # heartbeat over runToolLoop (replaced by Cordis heartbeat test)
   electron/lib/user-style-generation.live.test.ts:25  # runToolLoop branch (port to Cordis if kept)
   electron/lib/pi-agent-prompt-trim.test.ts:34     # live runToolLoop A/B (keep the offline buildPiAgentSystemPrompt asserts)
   ```
   **Keep:** `delta-batcher.test.ts`, `llm-stream.test.ts`, `llm-transport.test.ts`, `responses.test.ts`, `llm-sendable.test.ts`, `token-breakdown-images.test.ts` (shared), plus Cordis `compaction-retry.test.ts`, `doom-loop.test.ts`, `cairn-attachment-store.test.ts`.

6. **Wire manual `/compact` on Cordis** — the current `pi-agent:compact-now` handler at `pi-agent.ts:660-726` is still the builtin `compactNow` stub. Replace it with `ctx.compaction.compactNow(agent, signal)` on the live agent handle. Options: expose the current agent from `runCordisCodingLoop` (return it), or add a `compactNow` callback that `runCordisCodingSession` registers while a turn is active. Auto-compaction already runs via `BasicCompactionEngine {auto:true}`; this step only adds the explicit user command.

#### 2d — Prune dead DB plumbing (one PR, after the file deletions, ~1 day)

Only `pi_agent_llm_history` is dead on Cordis — everything else stays.

| Table / query | Verdict | Action |
|---|---|---|
| `pi_agent_llm_history` + `saveLlmHistory`/`getLlmHistory` (`electron/db/queries.ts:1798/1821`, `schema.ts:391`, `pi-agent.ts:70 scheduleHistorySave`) | **Dead** — Cordis logs to `dsh-session-persistence-jsonl` (`<userData>/sessions`); no `pi_agent_llm_history` writes on the Cordis path | Delete the table + queries + `scheduleHistorySave` + `pi-agent:restore-context`'s `getLlmHistory` branch (Cordis resumes via `ctx.sessionPersistence.inspect` → `ctx.agents.resume`). Add a one-time migration that drops the table if it exists. |
| `pi_agent_sessions` + `pi_agent_messages` (`schema.ts:367-397`, `queries.ts:1633-1670`) | **Keep** — tab strip + `mode/plan_note_id/status` still read/written on Cordis; `mergeProject` repoint stays | Keep; only the `saveLlmHistory`-backed transcript inside the session is dead |
| `pi_session_todos` (`schema.ts:1020`, `queries.ts:1768`) | **Keep** — todo dock | Keep |
| `chat_threads` / `chat_messages` (`schema.ts:110-127`, `queries.ts:1024-1053`) | **Keep** — `cairn-session` plugin persists on Cordis; mobile/SSE/popout surface | Keep |
| `shared/models/pdf-attach.ts` `buildAttachmentParts` | **Builtin wire-format only** — Cordis uses `CairnAttachmentStore` + `buildCordisUserContent` | Stop calling `buildAttachmentParts` on Cordis (already done); keep `validateAttachmentDataUrl`/`supportsPdfInput`/`pdfTokenEstimate`/`MAX_ATTACHMENT_BYTES` for renderer/mobile/token accounting |
| `electron/preload.ts` `pi-agent:*` / `chat:*` channels | **Keep all** — contract is engine-agnostic | Keep; only the implementation behind them becomes cordis-only |

#### Verification checklist (run after every Phase 2 PR)

```
npm run type-check:all          # no dangling imports from deleted files
npm run compile                 # esbuild bundles without NODE_BUILTINS errors
npx vitest run electron         # shared + Cordis suites green (expect ~75 files, not 90)
CORDIS_LIVE=1 npx vitest run electron/cordis/coding-agent.live.test.ts  # 8 live capabilities still pass
# Manual smoke:
#   chat:stream with an image attachment → model describes it
#   pi-agent:prompt in plan mode → read-only gate holds
#   pi-agent:prompt with a mutating tool → approval dialog fires
#   user-style:generateStream → style guide streams back
#   heartbeat runAutomation → data tools only, no shell
```

#### Rollback

There is no rollback to builtin after Phase 2 deletes the files. If a Cordis regression is found post-delete, fix it on Cordis — the builtin code is gone. This is why the soak gate (Phase 2 header) is required before starting.

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

**Where we are:** Phase 1 (chat) DONE + shipping. **Phase 1.5 (coding agent) DONE** — 2a–2l all built + verified AND the FINAL wiring is complete: the coding agent runs on Cordis by default (`CAIRN_ENGINE=builtin` is the escape hatch). Capability parity proven live: streaming, tools, plan mode, HITL approvals, doom-loop, skills, sandbox (workspace-write), image attachments, auto-compaction, retries, jsonl session persistence + resume. **Next: Phase 2** (delete the frozen builtin loops once the flipped default has soaked in production) then **Phase 3** (in-app user plugins + adopt the dsh client/UI layer — see §9 + the Phase 3 kickoff below).

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

**Next concrete steps — see Phase 2 above for the full deprecation/removal plan, then Phase 3 kickoff in §9.**

- **Immediate next:** Phase 2a — Deprecate (add `console.warn` on the builtin branch + mark `config-cache.ts:engine` as `@deprecated`). One PR, no deletions, keeps `CAIRN_ENGINE=builtin` working as the escape hatch while it self-identifies as deprecated.
- **Then:** Phase 2b → 2c → 2d in order (port the two remaining callers → collapse the dual paths + delete the 5 frozen source files → prune `pi_agent_llm_history` + builtin-only tests → remove the toggle). Each phase has its own verification checklist — see Phase 2 above.
- **Phase 3 kickoff** is in §9 (six-step bridge-plugin workstream: boot the in-process dsh host web stack behind `CAIRN_UI=dsh`, then `cairn-root-layout` → `cairn-toolview-*` → `cairn-persistence-bridge` → brand/theme → retire the IPC bridge). §9 lists the exact dsh packages, the arch note, and the slot names to occupy.

**Phase 3 (in-app user plugins + dsh client/UI) — HOW TO START.** The full design + feasibility is in §9; the six-step bridge-plugin workstream is enumerated there. Concrete kickoff:
1. **Spike the in-process host (§9 step 1, option A).** In `electron/main.ts` (after the workspace ctx is built) boot the dsh host web stack on the SHARED Cordis ctx: `dsh-host-webserver` (plain `node:http`) + `dsh-host-apiproxy` + `dsh-client-connection` + `frontend-static`, then `mainWindow.loadURL("http://127.0.0.1:<port>")` behind a `CAIRN_UI=dsh` flag (mirror the `CAIRN_ENGINE` gate so the current renderer stays default). Reference the dsh repo at `scratch/dsh-repo` (see §9 findings) and the arch note `2026-07-19-gui-layering-and-rpc-protocol.md`. Verify Electron's Node 22 satisfies dsh's `^22.19 || >=24` engine.
2. **`cairn-root-layout` client plugin (§9 step 2).** Occupy the `root` slot (replacing `ui-layout`/`ui-sidebar`) so Cairn's notes/board/graph/insights render as peers of the dsh conversation column — or, smaller first step, add them as `conversation.view` tabs.
3. **`cairn-toolview-*` plugins (§9 step 4).** Register keyed `tool.call.toolview` React views for Cairn's data tools (`get_note`, `ensure_note`, board tools…), following how `ui-skill` registers the `skill` view — this is where Cairn's tools get rich UI "for free".
4. **`cairn-persistence-bridge` (§9 step 5).** The hardest seam: reconcile the dsh append-only session jsonl with Cairn's SQLite notes/boards (Cairn tools already run on the shared host ctx and log model-visible results to the session log — that invariant is the bridge point).
5. **Brand/theme (§9 step 3):** `cairn-brand` occupies the brand slots (dsh only fills them under `DSH_CLIENT_BUILD_PROFILE='official'`); `cairn-theme` maps Cairn's `--*` tokens ⇄ dsh's `--dsw-*` tokens.
6. **Retire the bespoke IPC bridge (§9 step 6)** once dsh's connection layer carries the same events the `pi-agent:*`/`chat:*` channels do today.

Loop = `electron/cordis/run-cordis-coding.ts`; wiring = `electron/ipc/pi-agent.ts` (`runSession` → `runCordisCodingSession`); plugins = `cairn-plugins.ts`; shared services in `getContext` (tokenMeter/compaction/llm-retry/attachments); proofs = `coding-agent.live.test.ts` (8 live) + `doom-loop.test.ts` + `compaction-retry.test.ts` + `cairn-attachment-store.test.ts` (unit).

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