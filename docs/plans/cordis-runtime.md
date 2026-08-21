# Cairn Cordis Runtime — Rollout Plan

Status: **Phase 1 + 1.5 + 2 COMPLETE; A (heartbeat full agent) + C (manual /compact) DONE; D (Electron QA e2e harness) IMPLEMENTED — remaining: Phase 3. Plugin-system port investigated (§10 backend Loader; §11 UI-bridge into Cairn's OWN frontend, NOT the dsh shell)** · Updated: 2026-08-20
Owner: Cairn maintainer
Related note: *DeepSeek Harness (dsh) integration analysis* (Cairn project)
Branch: `feat/cordis-runtime` · Latest: `7df175ca`

---

## ⭐ REMAINING WORK (scope for the next session — read this first)

Cordis is the **only engine** — chat, coding agent, automations, user-style, and every one-shot all run through it. The frozen builtin loops, `pi_agent_llm_history`, and `CAIRN_ENGINE` are **deleted** (`90f0b960`). Full electron suite 77 files/1106; live coding 8/8.

### A. Heartbeat → run a full coding agent (DONE ✅)
`heartbeat-runner.ts:441` runs `runCordisCodingLoop` (the full agent) with `cwd=runDir`, `sandboxMode:"workspace-write"`, all tools (bash/write/edit/read/grep/todo + Cairn data + connectors + skill + `run_script`/`write_run_file`/`deliver_file` via the new `extraTools` option at `run-cordis-coding.ts:86`), and `autoApprove` when `approvalMode != ask`. `pi-agent:*` tool/token/usage events map to `automation:run` events; transcript, artifacts, and error-status preserved. **Approvals forwarded to the UI**: `approvals.registerPending` runs the automation's policy (`shouldAutoAllowAutomationTool` — read tools + standing rules + auto-mode built-ins pass; writes/scripts/external calls forward), emitting an `automation:run` `{event:"approval", tool, callId}` and blocking on the new `automation:approve` IPC (`db-handlers.ts`, preload `automation.approve(callId, approved, grant?)`). The `RunWatcherModal` shows Approve / Always Allow / Deny. "Always Allow" (`grant:"always"`) persists via `recordStandingAllowance` so the next run auto-approves; `grant:"session"` remembers within the turn. Autonomous mode = `approvalMode:"auto"` (already auto-approves built-ins; only connector-aware external calls forward).

### B. Phase 3 — In-app user plugins + dsh client/UI (the big unlock, 3–6 wks)

> **Goal:** replace Cairn's bespoke React frontend + `pi-agent:*`/`chat:*` IPC with the **dsh web GUI** running in-process, so third-party dsh plugins contribute UI too (via slot-based plugin-UI), not just backend. All research below is done — a fresh session can start coding without re-discovering the packages.

#### Verified ground truth (2026-08-19 — do NOT re-research)
- **Host/client packages ARE published on npm at `0.0.1-rc.1`** (checked via `npm view` + downloaded tarballs): `@deepseek-ai/dsh-host-webserver`, `dsh-host-apiproxy`, `dsh-client-connection`, `dsh-web-app` all installable. (Earlier §9 "publish set incomplete" risk applies to *other* packages, not these — re-verify `npm install` at step 1.)
- **Full dsh monorepo source** is in `scratch/dsh-repo/packages/` (55 pkgs, gitignored) — use it as reference/fallback if npm is missing something.
- **Boot composition** (what mounts on the shared Cordis ctx):
  - `dsh-host-webserver` (`ctx.httpServer`) — low-level `node:http` route + upgrade registry, fallback seat, `tapIndex`. Config `{host:'127.0.0.1', port}` (port 0 = OS-assigned, read via `ctx.httpServer.port`). Web-shape only; serves no files.
  - `dsh-host-apiproxy` (`ctx.apiProxy`) — the API gateway, transport-agnostic. Exports `createApiProxy`, `ApiProxyService`, `toFetchHandler`, `AbstractApiClient`/`InProcessApiClient`.
  - `dsh-client-connection` (`HostConnectionService`, injects `["apiProxy"]`) — mounts the browser RPC gateway under `/api` (browser-trust fence, DNS-rebinding defense), WebSocket downlink, `HOST_EVENTS_PATH`/`MUX_EVENTS_PATH`.
  - `dsh-frontend-static` — the fallback owner that serves the SPA dist (via the webserver's `registerFallback`).
  - `dsh-web-app` — the runtime glue plugin: resolves the built frontend dist, mounts `frontend-static` over it, registers web-surface prompt sections + `DSH_WEB_URL`/`DSH_WEB_MODE` env vars, prints the URL line. Config `{mode:'production'|'development', printUrl}`.
- **Electron anticipates this:** arch note names a future `AbstractApiClient.doFetch` IPC subclass; `dsh-host-webserver` README: "Electron loads dist over file:// and carries fetch over an IPC bridge." Two host options: **(A)** run the in-process server + `loadURL("http://127.0.0.1:<port>")` — simplest, keeps WebSocket unchanged; **(B)** `file://` + IPC `doFetch` carrier — the design's preferred path, bigger lift. **Start with A.**
- **White-label:** `ui-brand-official` fills brand slots only under `DSH_CLIENT_BUILD_PROFILE='official'`; a deployment/brand plugin occupies the same slots. `ui-theme` uses `--dsw-*` tokens (≠ Cairn's `--*`; needs a mapping layer if both coexist in one DOM).
- **Layout is all-or-nothing:** `ui-layout` occupies the `root` slot (fixed 3-col AppFrame: sidebar|conversation|details). To host Cairn's notes/board/graph/insights as peers, write a Cairn `root`-occupying layout plugin (replace `ui-layout`/`ui-sidebar`). Or add Cairn views as `conversation.view` tabs.
- **Cairn data tools get UI for free:** `tool.call.toolview` is a keyed-slot extension point — a client plugin registers `key:'<toolName>'` React views (e.g. `ui-skill` registers the `skill` view). Unregistered tools fall back to a generic card.
- **Persistence = hardest seam:** dsh jsonl (append-only SessionEvent log) ⇄ Cairn SQLite notes/boards. Bridge = Cairn tools (on shared host ctx) read/write SQLite while logging model-visible results to the session log (dsh invariant: "model-visible ⟺ logged").

#### Step-by-step (in order, each independently merges)
1. **Spike (in `/tmp`, NOT the repo first):** `npm install` the 4 host packages in a throwaway dir; mount them on a minimal Cordis ctx (reuse the pattern from `getContext` in `run-cordis-loop.ts:250`); boot `dsh-web-app` (production mode) on `127.0.0.1:0`; open a plain Electron `BrowserWindow.loadURL("http://127.0.0.1:<port>")` and confirm the dsh web GUI renders + the conversation works against the local Rork bridge. This proves option A end-to-end before touching `electron/main.ts`.
2. **Wire into `electron/main.ts`** behind `CAIRN_UI=dsh` (mirror how `CAIRN_ENGINE` gated the engine — env-var escape hatch, current renderer stays default). Mount the host stack on the SHARED Cordis ctx (after `getContext`/`setSessionRoot` at `main.ts:248`), then `mainWindow.loadURL(...)` when `CAIRN_UI=dsh`. Add `node:http`/`node:net`/`node:tty` etc. to the esbuild externals + `NODE_BUILTINS` bundle-guard if needed.
3. **`cairn-root-layout` client plugin** — occupy the `root` slot (replace `ui-layout`/`ui-sidebar`), rendering the dsh conversation view + Cairn's nav/views (notes/board/graph/insights) as peers, so Cairn's product surface survives inside the dsh shell.
4. **`cairn-brand` / `cairn-theme`** — brand occupants + a `--dsw-*` ⇄ `--*` token mapping layer (only if Cairn + dsh coexist in one DOM; if the root layout keeps them separate, mapping may be unnecessary).
5. **`cairn-toolview-*`** — keyed `tool.call.toolview` React views for Cairn's data tools (`get_note`, `ensure_note`, board tools…), so they render rich cards instead of the generic fallback.
6. **`cairn-persistence-bridge`** — reconcile dsh session jsonl ⇄ Cairn SQLite (threads/notes/boards), preserving the "model-visible ⟺ logged" invariant. Reuse the existing `cairn-session`/`cairn-tools` plugins' DB access.
7. **Retire the bespoke `pi-agent:*`/`chat:*` IPC bridge** once the dsh connection layer carries the same events.

#### Exit criteria
- `CAIRN_UI=dsh` loads the dsh web GUI in Electron with the conversation + Cairn views working.
- Third-party dsh plugins with UI slots render inside Cairn.
- Current renderer still works via the default (non-`CAIRN_UI`) path; both are testable.

### C. Manual `/compact` on Cordis — DONE ✅
`pi-agent:compact-now` (`pi-agent.ts:551`) opens the session's agent from its persisted jsonl (`openCordisAgent` at `run-cordis-coding.ts`), runs `ctx.compaction.compactNow(agent, signal)`, and disposes it — a real user-triggered compaction. Auto-compaction (`BasicCompactionEngine`, 80%) still runs between steps. The chat `/compact` (`chat.ts:90` `chat:compactThread`) works via `runOneShot`.

### D. QA e2e — boot the REAL Electron app + drive the Cordis loops (new harness) — IMPLEMENTED ✅

**Goal:** a test that boots the actual Electron app (not the mocked-IPC Next dev server) and drives each Cordis loop end-to-end through the real IPC + renderer — e.g. open chat and "summarize this project", open the agent and have it make a change, trigger a heartbeat automation. So `npm run test:e2e` (or a new `test:e2e:electron`) confirms everything works in the real app, not just at the `runCordisCodingLoop` unit level.

**Delivered (2026-08-19):**
- `tests/e2e/electron/cordis-qa.test.ts` — boots the real app via `_electron.launch` and drives the **chat loop** (`chat.stream` → `runCordisLoop` → `chat:done`), the **coding loop** (`piAgent.prompt` → `runCordisCodingLoop` → `pi-agent:done`), and the **heartbeat loop** (`automation.runNow` → `runAutomation` → `finished`). Each is gated behind `CORDIS_LIVE=1 CORDIS_DUMMY_KEY=local` and asserts on plumbing (events fired, no error, tokens>0) not model text.
- `playwright.electron.config.ts` — reuses the Next dev webServer (the Electron window loads it in dev mode) + `_electron.launch`. `DEMO_RECORD=1` turns on `recordVideo` → `electron-recordings/`.
- `npm run test:e2e:electron` script (`npm run compile && playwright test -c playwright.electron.config.ts`).
- **`CAIRN_USER_DATA_DIR` env hook in `electron/main.ts`** — redirects `app.setPath("userData")` before `whenReady` so the harness runs against a throwaway profile (never touches the developer's real Cairn data). The harness seeds `workspace-config.json` + `ai-settings-cache.json` into that dir pre-launch, then creates a workspace/project/note through the real store.
- `scripts/demo-record.ts` — a standalone demo/video recorder that drives the REAL UI (types into the chat input by placeholder, submits, tours views) on a deterministic timeline for product/marketing videos.

**Verified:** app boots under Playwright Electron, userData isolation works, store attaches, seeding (workspace/project/note) succeeds, and config points at the bridge — all validated with a throwaway probe (since the live model bridge isn't up in this environment). The three tests load and skip correctly without `CORDIS_LIVE`. A full live run needs the bridge at `CORDIS_TEST_BASE_URL` (default `http://localhost:3042/v1`).

**Why a new harness:** the existing `tests/e2e/smoke.test.ts` + `playwright.config.ts` run against the **Next.js dev server with `window.electron` mocked** (`buildIpcMock` via `addInitScript`) — the Cordis loops never actually run. The live tests (`electron/cordis/*.live.test.ts`) call the loops directly, bypassing the renderer + IPC. This QA tier fills the gap between them.

**Approach (Playwright Electron support — `@playwright/test` already ships `_electron`):**
1. **Launch the real app** with `import { _electron as electron } from "@playwright/test"` + `electron.launch({ args: [path.join(__dirname, "../../dist-electron/main.js")], userDataDir: <temp> })`. `userDataDir` isolates the test from real user data; seed a **fixture workspace** (a temp dir with a `workspace.json`/`.cairn` pointing at a small notes project) so the app boots to a known state.
2. **Point at the live model bridge** — same as `CORDIS_LIVE=1`: the Rork bridge at `http://localhost:3042/v1` (config via the app's `ai-settings-cache.json` in `userDataDir`, or set the cached `agentConfig`/`aiConfig` before launch). Gate the whole file behind `CORDIS_LIVE=1` + `CORDIS_DUMMY_KEY=local` so it skips without the bridge (same as the live tests).
3. **Drive the renderer via the `ElectronApplication` API** (`app.firstWindow()`, `window.getByRole`/`getByPlaceholder`) — open the Chat pane, type "summarize this project", submit, and assert `chat:done` renders a non-empty assistant message; do the same for the Agent pane (a write/plan task) and a `runAutomationNow` heartbeat. Optionally assert the `chat:usage`/`pi-agent:usage` events fired (real usage recorded).
4. **Emit-assert both directions**: `app.evaluate` to read store state; listen for the main-process events via the renderer's preload subscriptions.
5. **Isolated config:** set `userDataDir` so `app.getPath("userData")` resolves to a temp dir (sessions jsonl + `ai-settings-cache.json` + the sqlite DB all live there) — the app's `main.ts:150/240` already reads everything from `userData`, so a fresh dir gives a clean, deterministic boot.

**Checks to include (one test per Cordis loop):**
- **Chat loop** (`chat:stream` → `runCordisLoop`): "Summarize this project" → assistant reply + usage event, no `chat:done` error.
- **Agent/coding loop** (`pi-agent:prompt` → `runCordisCodingLoop`): plan-mode write is gated, or an execute-mode edit produces the file in the fixture workspace.
- **Heartbeat** (`runAutomation`): a data-only automation completes with a `run-log.json` + notification.
- **Attachments**: attach an image to chat → model describes it (round-trips `CairnAttachmentStore`).
- **Approvals**: trigger a gated tool → `tool-confirm-required`/`automation:approval` event fires.

**Build steps:**
1. New `tests/e2e/electron/cordis-qa.test.ts` (gated `CORDIS_LIVE=1`).
2. A `test:e2e:electron` npm script (`playwright test tests/e2e/electron`) + a second `playwright.electron.config.ts` (Electron apps need `electron.launch`, not the `webServer` Next dev server — reuse the port-3000 webServer is wrong here; the Electron window loads its own `dist-electron`/Next URL, so launch Electron directly with the app's real entry).
3. Ensure `npm run compile` builds `dist-electron/main.js` first (the Electron entry the test launches).
4. Reuse `tests/fixtures/` for a minimal workspace + seed `ai-settings-cache.json` pointing at `http://localhost:3042/v1`.

**Risk/notes:** Electron in headless CI needs `xvfb` (or run headed locally). The app's `--user-data-dir`/`userDataDir` must be wired so it doesn't touch the developer's real Cairn data. Live-model tests are inherently non-deterministic (model output) — assert on plumbing (events fired, files created, no error) not exact text, mirroring the existing live tests' philosophy.

### Verification for any change
`npm run type-check:all` (ignore `scratch/` errors) + `npm run compile` + `npx vitest run electron` (77 files/1106) + `CORDIS_LIVE=1 CORDIS_DUMMY_KEY=local npx vitest run electron/cordis/coding-agent.live.test.ts` (8, needs bridge at `localhost:3042`).

---

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

### Phase 1.5 — Port the CODING AGENT to Cordis (DONE ✅ — 2a-2l + FINAL wiring)

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

### Phase 2 — Delete the old loops (DONE ✅ — 2a-2e, see front-matter)

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

> **Finding (2026-08-19): heartbeat sessions leak into `.cairn-sessions/`.** Each `heartbeat-runner.test.ts` creates a temp workspace under `os.tmpdir()` and calls `runAutomation`, which (via the shared Cordis `getContext`) writes a dsh session to the **fallback** session root `process.cwd()/.cairn-sessions/<encoded-cwd>/chat-*/session.jsonl.zstd` — because `main.ts:248` `setSessionRoot(<userData>/sessions)` is not reached in tests. These showed up as an untracked `?? .cairn-sessions/` in `git status` and as stray `chat-*` dirs in the workspace. Fixed: added `.cairn-sessions/` to `.gitignore` (the fallback root is a dev/test artifact, never a real user path), and `heartbeat-runner.test.ts` `afterEach` now deletes any `heartbeat-run`-prefixed dsh session dirs + the empty `.cairn-sessions/` dir. The real app sessions live under `<userData>/sessions/` (`main.ts:246`) — never `.cairn-sessions/`.

> **Finding (2026-08-19): heartbeat should run a FULL coding agent, not a slot-limited chat loop.** The runner currently calls `runCordisLoop` (`heartbeat-runner.ts:441`) passing only streaming callbacks — it does NOT pass `extraTools`, `runScript`/`writeRunFile`/`deliverFile`, or `makeApprovalGate`. That was a partial port. **Better design (recommended): switch heartbeat to `runCordisCodingLoop`** (`run-cordis-coding.ts:44`) with:
> - `cwd` = the automation run folder (`runDir`, `heartbeat-runner.ts:220`) — the agent operates in the isolated per-run working dir,
> - `sandboxMode:"workspace-write"` — mutations confined to `runDir` (the file-only persona already excludes shell, so the fs boundary is the safety),
> - **all tools for free**: `mountCodingStack` (`run-cordis-coding.ts:200`, bash/write/edit/read/grep/todo) + Cairn data tools + `registerExternalCairnTools` (`run-cordis-coding.ts:210`, the connector/MCP tools) + `skill`,
> - `systemPrompt` = the automation recipe + the KNOWLEDGE-WORK persona,
> - **approvals forwarded to the UI**: `runCordisCodingLoop` already emits `pi-agent:tool-confirm-required` and blocks on `pi-agent:respond-tool` via its `approvals` adapter (`run-cordis-coding.ts:75`). Heartbeat is headless, so bridge it: on a confirm request, emit an `automation:run` approval event (with the tool name/args + a callId) through `ctx.send` (`heartbeat-runner.ts:364`) and store the resolver; a new `automation:approve` IPC (renderer → main) resolves it. Same pattern for `questions` (`run-cordis-coding.ts:66`).
> - This replaces the old builtin `runScript`/`writeRunFile`/`deliverFile` executors: the agent can now `write`/`edit` files in `runDir` and run scripts via `bash` directly — no bespoke bridges needed. `makeApprovalGate` is superseded by the Cordis approval seam.
> **Status:** design decided; not yet implemented. Top follow-up after Phase 2 so heartbeat is fully functional (data + connectors + scripts) on Cordis.

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

#### 2e — One-shot LLM calls (not blocking Phase 2 deletion, but tracked here)

Phase 2a–2d removes the **loop** files (`chat-loop.ts:54 runToolLoop`, `pi-agent-loop.ts:628 runAgentLoop`, `compaction.ts:250 buildCompactionTransformer`). The **one-shot** callers below do NOT import those loops — they call `electron/lib/llm.ts:184 callLLM` / `llm.ts:168 postChatCompletions` directly, so deleting the loops does not break them. They are *not* the last remaining work for the loop deletion, but they are the last remaining **builtin transport** usage and should be migrated so the whole app goes through `dsh-llm-pi-ai` + `resolveTransport`.

| One-shot caller | File:line | What it does | Cordis replacement |
|---|---|---|---|
| `chat:compactThread` | `electron/ipc/chat.ts:90-115` → `electron/lib/compaction.ts:120 generateSummary` | Single `stream:true` LLM call that summarises a thread (`SUMMARIZATION_SYSTEM_PROMPT`, 7-section user prompt, `source:"summary"`) | Keep as-is for now (one-shot thread summariser, not an agent turn). Optional: `await ctx.llm.stream({ provider:"cairn", model, messages:[system,user], maxTokens:4096 })` via `dsh-llm` `LlmRuntime` (`node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:32 ctx.llm.stream`) — same `resolveTransport` probe, no tool loop |
| `user-style:generate` (non-streaming) | `electron/ipc/user-style-handlers.ts:112-151` → `llm.ts:184 callLLM({stream:false, reasoningEffort:"none", temperature:0.3→0.1})` | One-shot style guide without tools (fallback when `generateStream` not available) | Optional: `ctx.llm.stream` single-turn; keep the `isUsableGuide` retry gate |
| `ai:generateCommitMessage` | `electron/ipc/ai-handlers.ts:195-217:213` `callLLM(..., source:"commit-message")` | Diff → conventional-commit SUBJECT/BODY | `ctx.llm.stream` |
| `ai:generatePrDescription` | `electron/ipc/ai-handlers.ts:220-243:239` `callLLM(..., source:"pr-description")` | Branch diff → PR title/description | `ctx.llm.stream` |
| `ai:explainArchitecture` | `electron/ipc/ai-handlers.ts:250-272:268` `callLLM(..., source:"explain")` | Codebase summary → OVERVIEW/MODULES | `ctx.llm.stream` |
| `ai:generatePrd` → `generatePrd` | `electron/ipc/ai-handlers.ts:173` → `electron/lib/prd.ts:32 callLLM(..., source:"prd")` | Requirements → PRD note | `ctx.llm.stream` then `createNote` |
| `db:flow:node:summarize` | `electron/ipc/flow-handlers.ts:104-242:229` `callLLM(..., source:"flow-ai-summary")` | BFS reachable IdeaFlow nodes → summary written to `idea_flow_nodes.data` | `ctx.llm.stream` with `projectId/workspaceId` scoping |
| `spawn_tasks_from_note` (tool executor) | `electron/ipc/chat-executor.ts:238-296:250` `callLLM` inside `executeTool` | Note content → JSON tasks array → `create_task` + linking | `ctx.llm.stream` inside the tool, or keep as-is until `registerCairnTools` owns it fully |

**Port: `electron/cordis/one-shot.ts`** — thin helper, not a Cordis plugin. `ctx.llm` (`dsh-llm` `LlmRuntime` at `run-cordis-loop.ts:158`) already *is* the one-shot surface; wrapping it in a `Service`/`apply` adds lifecycle with no benefit (one-shots are request-scoped, not context-scoped). The helper below is what Phase 2e ports each caller to — `provider:"cairn"` is the internal pi-ai route that forwards the user's selected `baseUrl`/`model` (OpenAI, Anthropic, Ollama, etc. via `run-cordis-loop.ts:188` registration), not a vendor lock-in.

`electron/cordis/one-shot.ts:10` `export async function runOneShot(ctx, { systemPrompt, userPrompt, config:{baseUrl,model,apiKey}, source, maxTokens, temperature, signal })`:
- `await ensurePiAiAdapter(ctx, { baseUrl, model, apiKey, api: apiFor((await resolveTransport(baseUrl, apiKey)).mode) })` — same probe the loops use
- `for await (const c of ctx.llm.stream({ provider:"cairn", model, messages:[{role:"system",content:systemPrompt},{role:"user",content:userPrompt}], maxTokens }))` accumulate `c.type==="text-delta"` + `recordLlmUsage` — transport-agnostic, keep `calculatePromptBreakdown`

**Pattern to migrate one-shots** — mechanical, via the helper above (same `resolveTransport` + `ensurePiAiAdapter` the loops use):
```ts
// Before (builtin):
const text = await callLLM({ baseUrl, model, apiKey }, systemPrompt, userPrompt,
  { source:"commit-message", temperature:0.3, maxTokens:4096 });

// After (Cordis single-turn via helper):
import { runOneShot } from "../cordis/one-shot";
import { getContext } from "../cordis/run-cordis-loop";
const text = await runOneShot(await getContext(), { systemPrompt, userPrompt,
  config:{ baseUrl, model, apiKey }, source:"commit-message", temperature:0.3, maxTokens:4096, signal });
// Helper internally does: ensurePiAiAdapter + ctx.llm.stream({provider:"cairn", model, messages}) + text-delta accumulation + recordLlmUsage
```
Keep `recordLlmUsage` / `calculatePromptBreakdown` — helper keeps them, they are transport-agnostic.

**Sequencing:** do NOT block Phase 2c (loop deletion) on one-shots. One-shots survive the deletion. Migrate them as **Phase 2e** after the loops are gone, one handler at a time, with the same soak gate. `chat:compactThread` can stay on `generateSummary` longest because `dsh-compaction-basic` already handles agent compaction separately.

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

## 8. Session handoff — historical status (superseded by front-matter)

**Branch:** `feat/cordis-runtime` · **Latest commit:** `156f694b` · tree clean.

**Where we are:** Phase 1 (chat) + **1.5 (coding) + 2 COMPLETE** — Cordis is the only engine; the frozen loops, `pi_agent_llm_history`, and `CAIRN_ENGINE` are deleted (`90f0b960`). **A (heartbeat → full coding agent + approvals forwarded to UI + always-allow)** and **C (manual /compact via `openCordisAgent` + `ctx.compaction.compactNow`)** both DONE (`7df175ca`, `b4408ed1`). Full electron suite 77 files/1106; live coding 8/8. **Next: Phase 3 step 1** — the dsh client/UI spike (boot the in-process host web stack in Electron behind `CAIRN_UI=dsh`; full plan + verified package ground-truth in the `B` section at the top of this doc).

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

**Next concrete steps — Phase 3 (the dsh client/UI + in-app plugins).**

**Phase 2 is COMPLETE** — the frozen builtin loops, `pi_agent_llm_history`, and `CAIRN_ENGINE` are all deleted (`90f0b960`). No builtin plumbing remains. Cordis is the only engine for chat, coding, heartbeat, user-style, and every one-shot.

- **Immediate next:** **Phase 3 kickoff** in §9 (six-step bridge-plugin workstream: boot the in-process dsh host web stack behind `CAIRN_UI=dsh`, then `cairn-root-layout` → `cairn-toolview-*` → `cairn-persistence-bridge` → brand/theme → retire the IPC bridge). §9 lists the exact dsh packages, the arch note, and the slot names to occupy.

**Phase 3 kickoff is in the `B` section at the top of this doc** (self-contained, with verified package ground-truth and step-by-step wiring). The full historical research + feasibility notes are in §9 below.

## 9. Adopting the dsh client/UI layer (Phase 3 — historical research, superseded by the `B` plan at the top)

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

## 10. Porting the PLUGIN SYSTEM — investigation + plan (2026-08-20)

**Question:** how do we port dsh's plugin system so third-party dsh plugins run in Cairn? (This is the backend half of Phase 3 — orthogonal to the UI/client half in §9/§B. A dsh plugin can contribute backend capability (tools, seams, services) with no UI; that's the first unlock and the cheaper one.)

### 10.1 Ground truth (verified 2026-08-20 — do NOT re-research)

Two reference writeups were produced this session (gitignored `scratch/`):
- `scratch/notes-plugin-loading.md` — dsh's profile/bundle/`cordis.patch.yml`/boot machinery (very thorough, file:line refs).
- Cairn's current mounting was read directly from `electron/cordis/run-cordis-loop.ts`.

**A. What a Cordis plugin actually is (installed `@deepseek-ai/cordis@4.0.1`, `lib/types/registry.d.ts`):**
- A plugin is one of: a **function** `(ctx, config) => void`; a **plain object** `{ name?, inject?, reusable?, apply(ctx,config), Config? }`; or a **class** with static `inject`/instance `apply` (the `Service` subclass form). `ctx.plugin(plugin, config?)` returns `Fiber & PromiseLike<Fiber>` — awaiting it settles the fiber (`registry.d.ts:198`). `ctx.inject(deps, cb)` is shorthand for `ctx.plugin({inject, apply:cb})` (`registry.d.ts:111/185`).
- **`inject`** is the capability-seam gate: a plugin listing `inject:["systemPrompt"]` has its fiber **wait** until another plugin `provide`s `systemPrompt`; accessing `ctx.systemPrompt` without declaring it in `inject` throws "cannot get property X without inject" (already a known Cairn gotcha, §8). This is exactly how `cairnSystemPromptPlugin`/`cairnQuestionsPlugin` are written today.
- Ordering between plugins is **service-availability driven, not row order** — a fiber activates once its injected services exist. (`base/cordis.patch.yml:12` "Row order carries no load semantics.") So mount order only matters for *await-blocking*; the Loader would resolve it declaratively.

**B. How dsh loads plugins (the machinery Cairn does NOT use):**
- dsh never hand-mounts. It composes **`cordis.patch.yml`** layers (YAML arrays of `{id,name,config?,inject?,disabled?}` entry rows, `!!js` expressions allowed) via the **Cordis Loader** (`@deepseek-ai/cordis-plugin-include` — provides `ctx.loader`), driven by `boot()` in `@deepseek-ai/dsh-app-boot`.
- A **bundle** = any npm package whose `package.json` has `"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}`. A **profile** = a dir with `package.json` `"dsh":{"profile":{"bundles":[...]}}` + a user `cordis.patch.yml`. `dsh plugin --profile X add <pkg>` is a **pnpm forwarder** that installs into the profile dir and appends any bundle it finds to `dsh.profile.bundles`.
- **HMR** (`@deepseek-ai/cordis-plugin-hmr`) reloads a plugin module on file change at the Context level; the boot layer also watches the user `cordis.patch.yml` and transactionally recomposes on edit (`app-boot/src/index.ts:232`).
- **Runtime self-modification** exists: `@deepseek-ai/dsh-cordis-host-runner` provides `ctx.dynamicCordisRunner` (a `node:vm` sandbox + fiber lifecycle for host-half plugin code, define→run→stop→undefine, session-scoped), driven by the model-facing `@deepseek-ai/dsh-tool-cordis` tools. This is dsh's answer to "user/agent adds a plugin live."

**C. Publish status (npm, checked 2026-08-20):**
| Package | Status | Role |
|---|---|---|
| `@deepseek-ai/cordis-plugin-include` | ✅ `1.0.6` | the Loader (`ctx.loader`) |
| `@deepseek-ai/cordis-plugin-hmr` | ✅ `1.0.16` | HMR |
| `@deepseek-ai/cordis-plugin-timer` | ✅ `1.1.3` | timer service (base dep) |
| `@deepseek-ai/dsh-app-boot` | ✅ `0.1.0-rc.6` | `boot()` + profile/bundle compose |
| `@deepseek-ai/dsh-settings` / `-settings-file` | ✅ `rc.1` / `rc.3` | per-plugin runtime config seam (`ctx.settings`) |
| `@deepseek-ai/dsh-cordis-host-runner` | ✅ `rc.3` | `ctx.dynamicCordisRunner` (live plugin lifecycle) |
| `@deepseek-ai/dsh-tool-cordis` | ✅ `rc.1` | model-facing cordis_define/run/stop tools |
| `@deepseek-ai/dsh-boot`, `@deepseek-ai/dsh-bundle-base` | ❌ unpublished | bundle META-packages (just `cordis.patch.yml` lists — **we don't need them**, we author our own patch/manifest) |

**Version-line caveat:** `dsh-app-boot` is on the `rc.6` line while every capability plugin Cairn pins is `0.1.0-rc.8`, and the Loader/HMR/timer are on their own `1.x` lines. Per the Phase-0 finding ("never trust ranges; pin the coherent snapshot"), `boot()` + the Loader must be integration-tested against the pinned rc.8 capability tree before trusting it (they share one `cordis@4.0.1` instance, which is the real ABI constraint).

**D. Where Cairn is today (`run-cordis-loop.ts:131-191` `getContext`):** Cairn does `new Context()` then **hand-mounts ~18 plugins imperatively** with `await ctx.plugin(importedPlugin, config)` (session, llm, system-prompt, agent, tools, user-questions, approval, jsonl-persistence, agent-loop, attachment-store, token-meter, compaction, llm-retry, subagent×3), plus `registerCairnTools`/`registerExternalCairnTools` and per-turn `cairn-*` plugins. **No Loader, no `cordis.patch.yml`, no profile/bundle, no HMR, no settings seam.** The `cairn-*` plugins are already idiomatic Cordis plugins (object `{apply, inject, name}`), so they are *already* Loader-compatible — they just aren't loaded *by* the Loader.

### 10.2 The gap (what's actually missing)

The capability layer is done. The **plugin-SYSTEM** (discovery + declarative composition + third-party install + lifecycle) is the gap:

1. **No declarative composition.** The mount list is TypeScript in `getContext`, not a data manifest. A third-party plugin can't be inserted without editing + recompiling Electron.
2. **No Loader.** Without `ctx.loader` (`cordis-plugin-include`), there is no entry registry, no `disabled:` gating, no config-replacement patching, no HMR-driven recompose, and nothing for `dsh-tool-cordis`/`dsh-cordis-host-runner` to hook.
3. **No install path.** dsh's `dsh plugin add` = pnpm-into-a-profile-dir. Cairn ships as a packaged Electron app (asar, no pnpm, arch-fenced native addons) — installing arbitrary npm at runtime is a real design problem, not a `spawnSync('pnpm')`.
4. **No sandbox for untrusted plugin code.** A dsh plugin's `apply` runs with full Electron-main privileges (raw `Database`, fs, net). dsh's own answer is `dsh-cordis-host-runner`'s `node:vm` sandbox; Cairn would need that or worker-thread isolation before running third-party code (already flagged Phase 3 bullet 2).
5. **No runtime config seam.** Cairn passes config as literals in `getContext`; dsh plugins expect `ctx.settings` namespaces the user can edit (the Plugins settings tab). Absent today.

### 10.3 Plan — three tiers, each independently shippable

**Tier 1 — Loader-backed composition (internal, no third-party yet). ~1 wk. The keystone.**
Replace the imperative `getContext` mount list with the Cordis Loader driven by a Cairn-authored `cordis.patch.yml`, so composition is data, not code — the prerequisite for everything else.
1. Add deps: `@deepseek-ai/cordis-plugin-include`, `-timer`, `-hmr`, `@deepseek-ai/dsh-app-boot`. Pin exact; integration-test against the rc.8 tree (verify one shared `cordis@4.0.1`). Add any new node builtins they pull to `NODE_BUILTINS` (bundle-guard) — `boot()`/include use `node:fs`/`node:url`/`node:path`; HMR adds a watcher.
2. Author `electron/cordis/cairn.patch.yml` (or a JS-object equivalent to dodge the YAML-in-asar + `!!js` eval concern — see risk) listing the current mount set as entry rows (`id`,`name`,`config`,`inject`). The `cairn-*` plugins register by a local module name the Loader can `import` (they're already object-plugins).
3. `getContext` becomes: `new Context()` → `ctx.plugin(Loader)` → feed it the patch list (mirror `mountRootInclude`/`boot` from `app-boot`, or call `boot()` with a `prepare` hook that provides `CAIRN_DB`, sessionRoot, etc. — Cairn's launcher-owned slots, exactly like dsh's `provideCmdline`). Keep `ensurePiAiAdapter` as an imperative post-boot step (it's endpoint-dynamic, not a static row) OR model it as a config-replaced row updated via `entry.update`.
4. **Exit:** chat + coding + heartbeat + one-shots all run through the Loader-composed tree; full electron suite + 8 live coding capabilities green; `CAIRN_ENGINE`-style env escape hatch NOT needed (this is a refactor of composition, not behaviour). This alone buys `disabled:` gating + HMR for Cairn's own dev loop.

**Tier 2 — First-party bundle + settings seam (still trusted code). ~1 wk.**
5. Mount `@deepseek-ai/dsh-settings-file` (root `<userData>/cairn-settings.yaml`); migrate a few plugin configs (e.g. compaction `thresholdRatio`, sandbox default) from literals to settings namespaces so they're user-editable without a rebuild. Wire a minimal read-only **Plugins** inventory (dsh ships `dsh-host-plugin-inventory` → `pluginInventory/list` projecting Loader entries + fiber phase) behind a settings tab — even without third-party install, this makes the composed tree visible/toggleable.
6. Package Cairn's mount set as a proper first-party bundle (`package.json` `dsh.bundle.patch`) so the composition is reusable + testable as a unit, and so a future profile can layer over it.

**Tier 3 — Third-party plugins (untrusted). The real unlock — gated on a soak of Tier 1+2. 2–4 wk.**
7. **Install path (pick one):** (a) a Cairn-managed plugin dir under `<userData>/plugins` with a bundled pnpm/npm to install into it at runtime (heavy, but matches dsh) — the flat-symlink `profiles/node_modules` trick (`profile.ts:223`) keeps one shared `cordis` instance; or (b) accept only pre-bundled single-file plugins (esbuild'd to one JS) dropped into the dir, no npm at runtime (lighter, safer, but no transitive deps). Decision needed — lean (b) first.
8. **Sandbox:** run third-party `apply` via `@deepseek-ai/dsh-cordis-host-runner`'s `ctx.dynamicCordisRunner` (`node:vm` + fiber lifecycle, define→run→stop→undefine, browser-approval round trip) rather than inventing one. Add `@deepseek-ai/dsh-tool-cordis` so the AGENT can propose plugins too (the "agent modifies its own runtime" story), each `run` gated behind an explicit user approval (reuse Cairn's approval seam).
9. **UI:** the Plugins settings tab gains enable/disable (patch `disabled:` write to the user layer) + per-plugin settings cards (dsh `ui-settings-plugins` is the reference, but Cairn renders it in its own React — no dsh client layer needed for the backend-plugin story; that's §9's separate workstream).

### 10.4 Key risks specific to the plugin-system port
- **`!!js` in `cordis.patch.yml` = arbitrary eval.** dsh's patch files evaluate `!!js` expressions at mount. Shipping that verbatim in a packaged app is a code-exec surface. Mitigation: author Cairn's own composition as a **JS object list** (not YAML-with-`!!js`) fed straight to the Loader's `applyEntryPatches`, keeping `!!js` OFF for any third-party/user-supplied layer (config-only, no expressions).
- **Version drift:** `app-boot@rc.6` vs capabilities `@rc.8` vs Loader/HMR `@1.x`. Must pin a coherent snapshot and integration-test; if `boot()` fights the rc.8 tree, we can use just `cordis-plugin-include` (the Loader) directly and skip `dsh-app-boot` (author our own tiny compose — we already do the equivalent imperatively).
- **asar + native addons:** third-party plugins can't dlopen arbitrary native code under Cairn's arch-fenced signing (AGENTS.md better-sqlite3 rules). Restrict third-party plugins to pure-JS, or require them to declare + ship arch-matched prebuilds (out of scope for Tier 3 v1).
- **Sandbox escape:** `node:vm` is NOT a security boundary against determined code. For genuinely untrusted plugins, worker-thread + message-passing (no shared `Database` handle) is the safer boundary — but that breaks the "tools run on the real DB handle" invariant. Trusted-first (Tier 1/2) sidesteps this; Tier 3 needs an explicit trust decision.

### 10.5 Recommended first step
**Do Tier 1 only, behind no flag** — swap `getContext`'s imperative mount for a Loader + a Cairn-authored JS entry-list (not YAML). It's a pure refactor with a green-suite exit criterion, it introduces the Loader (the keystone every later tier needs), and it immediately proves the pinned capability tree composes under `boot()`/include without regressions. Ship it, soak it, then decide Tier 2/3.

### 10.6 SPIKE RESULTS (2026-08-20 — de-risked in a throwaway dir, DONE)

Ran the Tier 1 spike in `/var/folders/.../opencode/cordis-loader-spike` (throwaway, per plan). **All green — Tier 1 is viable exactly as designed.**

**Install / dedupe:**
- The Loader stack installs cleanly alongside the pinned rc.8 capability tree: `@deepseek-ai/cordis-plugin-loader@1.0.2` (provides `ctx.loader`), `cordis-plugin-include@1.0.6` (the `cordis:include` YAML/JSON entry-tree — **we don't need it**), `cordis-plugin-timer@1.1.3`, `cordis-plugin-hmr@1.0.16`, `dsh-app-boot@0.1.0-rc.6`.
- **Single `@deepseek-ai/cordis@4.0.1` copy** — dedupe is clean (the real ABI constraint). `dsh-app-boot` only hard-deps `js-yaml`; it treats cordis/loader as host-provided peers.
- **Correction to §10.1:** the Loader is `@deepseek-ai/cordis-plugin-loader` (exports `Loader`, `applyEntryPatches`, `EntryTree`, `evaluate`/`interpolate`/`isJsExpr`); `cordis-plugin-include` is a thin `EntryTree` subclass (`static inject=["loader"]`) that reads a `cordis.yml`/JSON file. **Cairn should mount `Loader` and drive it programmatically — skip `Include` (no file) and skip `boot()` (it reads a profile dir + `cordis.yml` from disk, unnecessary for us).**

**API proven (`ctx.loader` after `await ctx.plugin(Loader)`):** `create(options)`, `update(config)`, `entries()`, `resolve(id)`, `import(name)`, `await()`. `import(name)` has three resolution paths (`cordis-plugin-loader/lib/index.js:260`):
  1. `name.startsWith("cordis:")` → `ctx.loader.builtins[name.slice(7)]` — **no module resolution** (asar-safe).
  2. `ctx.loader.internal.import(name, baseUrl)` — a swappable `ModuleLoader` (the `bareModuleBaseUrl` hook `boot()` uses).
  3. plain `await import(name)` — bare npm names + relative-from-`baseUrl`.

**→ Decision (REVISED at implementation — see §10.7): register EVERY plugin (dsh + cairn) as a `cordis:` builtin.** The spike's mixed "dsh = bare name, cairn = builtin" split does NOT survive esbuild: `main.ts` bundles to CJS and esbuild cannot see the Loader's runtime `import("<string>")`, so bare-name dsh packages would 404 inside the asar. Fix: statically `import` every plugin (esbuild bundles them) and register ALL as builtins — `ctx.loader.builtins['dsh:tools']=toolsPlugin`, entry `name:'cordis:dsh:tools'`. Zero runtime module resolution, fully asar-safe. Proven in §10.7.

**Three assertions passed (against the pinned rc.8 tree):**
1. **Composition parity** — driving a JS entry-list (`[{id,name,config?}]`, NO YAML, NO `!!js`) through `ctx.loader.create()` + `await ctx.loader.await()` mounts session→llm→system-prompt→agent→tools and **`ctx.get('tools')` is a live service** (`object`), same as the imperative mount. `systemPrompt`/`llm` also resolve.
2. **Config threads** — `config:{marker:'HELLO-TIER1'}` on an entry arrives verbatim as the plugin's `apply(ctx, config)` 2nd arg.
3. **`inject`-gating works declaratively** — a local plugin with `inject:['systemPrompt']` created *before* the `system-prompt` entry still had its `apply` wait and correctly saw `ctx.systemPrompt` once it mounted (activation is service-availability driven, not creation order). This is the exact seam every `cairn-*` plugin relies on.

**Implication for the real port:** `getContext` becomes `new Context()` → `await ctx.plugin(Loader)` → register the `cairn-*` builtins on `ctx.loader.builtins` → `for (e of ENTRY_LIST) await ctx.loader.create(e)` → `await ctx.loader.await()`. `ensurePiAiAdapter` stays an imperative post-boot step (endpoint-dynamic; not a static row) OR becomes a config-replaced entry updated via `ctx.loader.resolve('pi-ai').update(...)`. The per-turn `cairn-*` plugins (session/usage/subagent/system-prompt/questions mounted per request in `runTurn`) can either stay per-turn `ctx.plugin(...)` calls or become Loader entries created/removed per turn — **keep them imperative in v1** (smaller diff; the Loader win is the static tree).

**§11 UI note (also de-risked 2026-08-20):** Cairn is **React 19.2.7**; dsh client packages peer `react:^18.2.0` (satisfied by 19 at the hook/`useSyncExternalStore` API level they use) and are **all published at `0.0.1-rc.1`** (`dsh-client-ui-slots`, `-ui-tool`, `-ui-primitives`, `-ui-runtime`, `-ui-skill`, `-ui-theme`). The React-version risk that could have killed §11 Strategy 1 is **cleared** — proceed to the toolview micro-host spike after Tier 1 lands.

## 11. Bridging plugin UI into Cairn's OWN frontend (investigation, 2026-08-20)

**Question:** we are NOT adopting dsh's whole web shell (§9/§B are the all-or-nothing path — replace Cairn's React with dsh's `ui-layout` `root` slot). We want to keep Cairn's bespoke frontend and let a dsh plugin's UI render *inside* it. Is that possible, and how coupled is a single plugin UI to the dsh shell?

### 11.1 Ground truth (verified from `scratch/dsh-repo/packages/client`, 2026-08-20)

**A. A client plugin is just a Cordis plugin running in a BROWSER Context.**
- `ClientContext = Context` (`packages/client/runtime/src/client/index.ts:112`). A plugin's browser half is `apply(ctx)` + `inject` exactly like the host half — but it runs in a **second Cordis tree in the renderer**, not the Electron-main tree. `package.json` declares it via `dsh.client` + `exports["./client"]`; the host half can be an empty `apply()` (ui-skill's is literally `export function apply(): void {}`, `ui-skill/src/index.ts`).
- The browser runtime (`packages/client/runtime`) owns a `SlotRegistry` + a snapshot store (bare `getSnapshot`/`subscribe`, useSyncExternalStore-shaped); `ui-renderer` binds that store to React. **ui-slots is "React-free and cordis-free" — React types only at runtime** (`ui-slots/README.md`) — so the slot core is portable; only the renderer binding is React.

**B. `tool.call.toolview` is a keyed slot with a tiny, self-contained data contract.**
- Registration (`ui-skill/src/client/index.ts`): `ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name:'tool.call.toolview', key:'skill', locale:NS }, SkillRow))`. `key` = the tool name; the transcript dispatches each tool call to the matching keyed view (unregistered tools → generic fallback).
- The view's props are **`ToolCallViewProps`** = the owner currency ONLY (`ui-tool/src/client/contract/slots.ts:29`): `{ callId, toolName, block, cwd?, home?, openFile(path), inspect?() }` where `block: ToolCallBlock = RunningToolCall | ToolResultNode` (`runtime/.../conversation.ts:311`) — the streaming-or-settled call+result slice. **A toolview derives its entire render from `block` + a couple of host callbacks. No session-wide store, no AppFrame, no conversation context is required as a prop.** (SkillRow: `skillRowModel(block)` reads `block.call.argsRaw` / result blocks; nothing else.)

**C. The real coupling is styling + primitives, not layout.**
- `SkillRow` imports icons/`StateDot` from `@deepseek-ai/dsh-client-ui-primitives` and its CSS module uses **20 `--dsw-*` theme tokens** (`--dsw-alias-label-primary`, `--dsw-alias-state-error-primary`, …). So rendered in isolation it's structurally fine but **unstyled/broken without dsh's `--dsw-*` tokens present** (Cairn uses `--*` tokens — a mapping layer is needed, already flagged §9/§B).
- Data-fetching toolviews (ui-skill also owns a `/` slash source) read `ctx.get('connection').api.*` RPCs off the browser root context — but that's the *source* half, NOT the toolview half. The `skill` **toolview** is explicitly "a replay-stable accent row derived only from each logged call/result slice" (`ui-skill/src/client/index.ts` header) — zero RPC. So a *pure* toolview (the common case: render this tool's call+result) needs no connection at all.

### 11.2 Verdict — YES, individual plugin UIs are embeddable

A single `tool.call.toolview` component is **highly isolatable**: it's a React component taking `ToolCallViewProps`. To host it inside Cairn's own transcript we need, per rendered call:
1. Build a `ToolCallBlock` from Cairn's own tool-call/result data (Cairn already tracks call args + output + ok/error in `useChatStream`/`ToolCallIndicator` — the same fields `RunningToolCall`/`ToolResultNode` carry).
2. Provide `openFile`/`inspect` shims wired to Cairn's own file-open/inspect (or no-ops).
3. Provide the `--dsw-*` tokens (a `cairn-dsw-theme.css` mapping `--dsw-*` → Cairn's `--*`) + mount `ui-primitives` (or shim the handful of primitives a given plugin imports).
4. A minimal browser slot registry so the plugin's `apply(ctx)` can `ctx.slots.register(...)` and Cairn can look the component up by `key`.

This does NOT require `ui-layout`, `ui-conversation`, `ui-sidebar`, or the dsh connection layer. It's a **micro-host**: a stripped browser Cordis Context in the renderer with just `SlotRegistry` + `locale` + `ui-primitives` + the token shim.

### 11.3 Two embedding strategies (pick per appetite)

**Strategy 1 — "toolview micro-host" (recommended; incremental, keeps Cairn's frontend).**
Run a tiny browser-side Cordis Context inside Cairn's renderer whose ONLY job is to collect `tool.call.toolview` (and later `conversation.chat.node`) registrations from installed client-plugin halves. Cairn's transcript renderer, when it hits a tool call whose `toolName` has a registered view, wraps it in a `<DswThemeScope>` (the token-mapping div) + the required providers and renders the dsh component with a Cairn-built `ToolCallViewProps`. Everything else in Cairn stays Cairn.
- **Pros:** Cairn's UI, nav, notes/board/graph untouched; adopt plugin UIs one slot at a time; no dsh web server, no `loadURL`, no IPC `doFetch` carrier.
- **Cons:** we own the `ToolCallBlock` adapter + the `--dsw-*` mapping + bundling each plugin's `./client` half into the renderer (esbuild) + a React-version match (dsh assumes React 19-era; Cairn is on its own React — verify before importing dsh components).
- **Scope:** slots beyond `tool.call.toolview` (e.g. `root`, `conversation.view`) are the shell's territory — a micro-host deliberately ignores them (or maps a whitelist). Settings/inspector slots could be added later the same way.

**Strategy 2 — full dsh shell (the §9/§B path).** Adopt `ui-layout`'s `root` + write a Cairn `root`-occupying layout to host Cairn views as peers. Gets ALL slots + third-party UI "for free," but replaces Cairn's frontend and forces the `--dsw-*`/`--*` reconciliation globally. Bigger lift, bigger blast radius. Only worth it if the end-state is "Cairn IS a dsh deployment."

### 11.4 Gaps/risks specific to UI embedding
- **React runtime match:** importing dsh's compiled React components into Cairn's renderer requires one React instance + a compatible version. If dsh targets React 19 and Cairn differs, either align or render the micro-host in an isolated React root. Verify FIRST — this can kill Strategy 1 cheaply.
- **`--dsw-*` token surface:** need a complete mapping (dsh's `ui-theme` defines the full `--dsw-alias-*` set). Build `cairn-dsw-theme.css` from dsh's `ui-theme` token list; scope it to the plugin-rendered subtree so it never leaks into Cairn's own `--*` styling.
- **`ToolCallBlock` fidelity:** the adapter must produce both the streaming (`RunningToolCall`) and settled (`ToolResultNode`) shapes so a plugin's running/ok/error states render — Cairn already has these signals (the recent `onToolCallDone status:"done"` fix), they just need reshaping into dsh's block type.
- **Bundling third-party `./client`:** a plugin ships browser code; Cairn must esbuild it into (or lazy-load it beside) the renderer. Same trust/sandbox questions as §10.3 Tier 3, but UI code is somewhat lower-risk than host `apply` (no DB/fs handle) — still, it runs in the renderer with Cairn's privileges, so treat as untrusted (isolated React root / no direct `window.electron`).
- **Depends on §10:** there is no point embedding a plugin's UI if its backend half can't mount. UI embedding (§11) is the *renderer* companion to §10's *host* Loader work — do §10 Tier 1 first (backend plugins load), then §11 Strategy 1 (their UIs render).

### 11.5 Recommended UI first step
After §10 Tier 1 lands: **spike Strategy 1 with the `skill` toolview** (a pure, RPC-free, replay-stable view we already understand). (1) esbuild `@deepseek-ai/dsh-client-ui-skill/client` into a renderer chunk; (2) stand up a micro browser Context with `SlotRegistry` + `ui-primitives` + a `--dsw-*` shim; (3) feed a Cairn-built `ToolCallViewProps` for a real `skill` tool call and render `SkillRow` inside Cairn's transcript. If SkillRow renders + themes correctly in Cairn, the pattern generalises to every keyed toolview and the "third-party plugins contribute UI inside Cairn" story is proven — without adopting the dsh shell. If the React-version match blocks it, fall back to isolated-React-root or reassess Strategy 2.

### 10.7 TIER 1 IMPLEMENTED (2026-08-20) — Loader-backed composition is live ✅

`electron/cordis/run-cordis-loop.ts` `getContext()` now composes the shared Cordis tree via the **Loader + a declarative JS `ENTRY_LIST`**, replacing the imperative `await ctx.plugin(...)` sequence. No behaviour change; pure refactor.

**Deps added (`package.json`, pinned exact):** `@deepseek-ai/cordis-plugin-loader@1.0.2`, `cordis-plugin-timer@1.1.3`, `cordis-plugin-hmr@1.0.16`. `npm i` → single `cordis@4.0.1` (dedupe clean). `dsh-app-boot` NOT added (we drive the Loader directly — no profile dir / `cordis.yml` from disk).

**The esbuild bundling wall (the one real gotcha):** `main.ts` bundles to CJS; esbuild cannot see the Loader's runtime `import("<string>")`, so referencing dsh plugins by **bare npm name** in the entry-list would resolve to nothing inside the packaged asar (works in dev from `node_modules`, breaks when packaged). **Fix:** keep every plugin as a **static `import`** at the top of the file (so esbuild bundles it) and register ALL of them — dsh defaults, the class-plugin `CairnAttachmentStore`, and the three named-export triples — as **`cordis:` builtins** (`loader.builtins['dsh:tools']=toolsPlugin`), with entries referencing `name:'cordis:dsh:tools'`. The Loader's `import()` fast-paths `cordis:` names straight to `builtins[...]` with zero module resolution → fully asar-safe. (Confirmed in §10.6 spike6: a fully-builtin tree yields a live `ctx.tools`.)

**Shape now:** `new Context()` → `await ctx.plugin(Loader)` → assign all plugins to `ctx.loader.builtins` → `for (e of ENTRY_LIST) await loader.create(e)` → `await loader.await()`. The `ENTRY_LIST` is a plain JS `[{id,name,config?}]` array (NO YAML, NO `!!js`). `ensurePiAiAdapter` + the per-turn `cairn-*` plugins + `registerCairnTools` stay imperative (endpoint-dynamic / per-request — deliberately out of the static tree for v1).

**Verification (all green):**
- `npx tsc -p tsconfig.electron.json` clean; `npm run compile` clean.
- Runtime service probe: after `loader.await()`, `ctx.get(...)` resolves `agentLoop / tools / userQuestions / approval / sessionPersistence / compaction / tokenMeter / agents` — identical to the imperative mount.
- **Full electron suite: 77 files / 1106 tests passing** (was 77/1106 — no regressions, no new node-builtins needed in the bundle-guard).
- Live coding capabilities: **6/8 pass** incl. all deterministic ones (plan-mode gate, HITL approval, skills injection+load, sandbox confine-in/deny-out ×2, image attachment round-trip). The 2 failures (turn-emits-tool-events; resume-recall-codeword) are **pre-existing model-behaviour flakiness** — verified by `git stash`-ing the change and reproducing the identical failures on the original imperative code (the chat `pi.live.test.ts` "recall zephyr" test fails the same way before and after). NOT a composition regression.

**Not yet done (deliberately deferred):** `disabled:` gating UI, HMR wiring for Cairn's own plugins, moving per-turn plugins into the Loader, and the settings seam — all Tier 2. Tier 1's win is the declarative static tree + `ctx.loader` existing (the keystone).

### 11.6 STRATEGY 1 SPIKE IMPLEMENTED (2026-08-20) — a dsh toolview renders inside Cairn ✅

Built the "toolview micro-host" (§11.3 Strategy 1) end-to-end. A real dsh `tool.call.toolview` component (the `skill` row) now renders **inside Cairn's own chat transcript** from a Cairn-built `ToolCallViewProps` — no dsh web shell, no `ui-layout`/`ui-conversation`/connection.

**New module `src/lib/dsh-toolview/`:**
- `contract.ts` — the dsh `ToolCallViewProps` + `ToolCallBlock` (`RunningToolCall | ToolResultNode`) shapes, vendored from `ui-tool/contract/slots.ts:29` + `runtime/.../conversation.ts:185/295` (only the fields a pure, replay-stable toolview reads).
- `adapter.ts` — `toToolCallViewProps(ChatToolCall)` — reshapes Cairn's existing tool-call data (tool/argsRaw/output/ok/error/running-vs-done) into dsh's block union. This is THE seam.
- `registry.ts` — a minimal keyed slot registry (`registerToolView(key, Component)` / `getToolView(toolName)`), the micro-host equivalent of `ctx.slots.register({name:'tool.call.toolview', key})`.
- `primitives.tsx` — local stand-ins for the 4 `ui-primitives` exports SkillRow imports (`IconSkillOutline16/ChevronDown14/Inspect12`, `StateDot`), matching dsh's `{size,className}` / `{state,size,className}` signatures. **Deliberately NOT the real `ui-primitives`** (it drags shiki+katex+micromark+cordis into the renderer — wrong for a spike; swapping in the real package later is a drop-in since signatures match).
- `dsw-theme.css` — the scoped `--dsw-*` → Cairn `--*` mapping (`.dsh-toolview-scope`), covering exactly the tokens SkillRow+StateDot reference; plus the vendored SkillRow CSS (prefixed `.dsh-skill-*`, scoped) so it never leaks into Cairn styling.
- `SkillRow.tsx` — a faithful vendored port of `ui-skill/src/client/SkillRow.tsx` (only changes: local primitives, plain classNames vs CSS-module, inlined `t()` — no dsh locale seat).
- `index.tsx` — `<DshToolView tc={...} />` (wraps a Cairn `ChatToolCall` in the theme scope + renders the registered view; returns null → Cairn's own chip) + `registerBuiltinToolViews()` (the plugin-browser-half equivalent) + `hasToolView()`.

**Wired live:** `ToolCallIndicator.tsx` now renders `<DshToolView tc={tc}/>` for any tool with a registered dsh view (currently `skill`), else falls through to Cairn's existing chip. So a `skill` tool call renders the dsh row in the running app.

**Verification (all green):**
- New `DshToolView.component.test.tsx` (**6 tests**, jsdom): registration by key; settled row renders "Skill" + the call's skill name inside `.dsh-toolview-scope`; expand-to-instructions shows the durable output; error state; running/streaming block; null-fallback for an unregistered tool.
- Full **component suite: 18 files / 144 passing** (no regressions).
- `npx next build` compiles the static export cleanly (validates the `.css` import + module bundles).
- Renderer `tsc -p tsconfig.json`: zero `src/` errors.

**What this proves:** individual dsh plugin UIs ARE embeddable in Cairn's frontend with a small, bounded bridge (contract + adapter + keyed registry + scoped `--dsw-*` shim). The pattern generalises to every keyed `tool.call.toolview`. The remaining step to true third-party UI is loading a plugin's real `./client` half (the same trust/bundling questions as §10.3 Tier 3) and using the real `ui-primitives`/`ui-slots` rather than vendored copies.

**Follow-ups (tracked):** (1) load the REAL `@deepseek-ai/dsh-client-ui-skill/client` + `ui-primitives`/`ui-slots` instead of vendored copies (proves it works with dsh's actual compiled components, not a port); (2) generate `dsw-theme.css` from dsh's `ui-theme` full token set rather than the hand-picked subset; (3) wire `openFile`/`inspect` to Cairn's real handlers; (4) surface it in the CODING agent transcript too (where `skill` calls actually originate) — chat rarely calls `skill`, so the live-app demo is currently exercised via the coding pane / the component test.

### 10.8 RUNTIME PLUGIN LOADING IMPLEMENTED (2026-08-20) — author a YAML, it loads live ✅

The north-star ("app running, you build a YAML and it loads — no restart") is working, behind `CAIRN_PLUGINS_DEV=1`. This is §10 Tier 2/3 step A+B+C1 collapsed into one working seam, on top of Tier 1's `ctx.loader`.

**How it works (`electron/cordis/plugin-loader.ts`):**
- Electron main sets the plugins root to `<userData>/plugins/` (`main.ts`, sibling to `setSessionRoot`).
- After the static `ENTRY_LIST` settles, `getContext()` calls `loadUserPlugins(ctx)` + `watchUserPlugins(ctx)` (no-op unless `CAIRN_PLUGINS_DEV=1`).
- `loadUserPlugins` reads `<pluginsRoot>/plugins.yml` (a top-level YAML array of `{id, name, config?, disabled?}`, parsed with `yaml.DEFAULT_SCHEMA` — **no `!!js`**, the file is untrusted data) and `ctx.loader.create()`s each enabled entry on the LIVE context.
- `watchUserPlugins` uses `fs.watch` (150ms debounce) → `reconcile()`: diff the manifest against the currently-mounted user entry ids, `loader.remove()` the gone/disabled ones, `loader.create()` the new ones. A config/body edit = remove+recreate.

**The two gotchas solved (both proven live):**
1. **Loading NEW code at runtime.** A `name: "./x.mjs"` entry is resolved to an **absolute `file://` URL against the plugins dir** + a `?v=<ts>` cache-bust (so edits reload past `import()`'s URL memoisation). The Loader's `import()` uses a runtime string → esbuild leaves it alone → it resolves against the real `<userData>` dir, NOT the asar. (A bare `?v=` on a *relative* name broke the Loader's URL rewrite — hence resolving to a full URL ourselves.)
2. **Plugins can't import app deps by bare name.** A file in `<userData>/plugins/` doing `import("@deepseek-ai/dsh-tools")` fails (Node resolves relative to the *plugin* file, which has no `node_modules`). Fix: Cairn exposes a tiny stable API on the context — **`ctx.cairn = { defineTool }`** — so a plugin uses `ctx.cairn.defineTool` (+ `inject:['tools']` → `ctx.tools.register`) instead of importing internals. This is the runtime plugin contract; keep it minimal + documented.

**Shipped example + docs:** `electron/cordis/plugins-template/` — `README.md`, `plugins.yml` (commented), and `hello-tool.mjs` (registers a real agent-visible `hello` tool via `ctx.cairn.defineTool` — the dsh `parameters` shape is a flat `{param: {type, required, description}}` map, NOT JSON-Schema).

**Verified (live):** `plugin-loader.live.test.ts` (gated `CAIRN_PLUGINS_DEV=1`) boots the real shared context, then — simulating you editing files while the app runs — writes `plugins.yml` + plugin files and asserts: a bespoke probe plugin loads with its config; the shipped `hello-tool` registers the `hello` tool into `ctx.tools`; emptying the manifest tears both down + unregisters the tool. Log: `loaded 'probe'` → `loaded 'hello-tool'` → `removed 'probe'`/`removed 'hello-tool'`. Full electron suite **1107 passing** (the +1 gated test skips without the flag); bundle-guard green (js-yaml bundles, no new node-builtins). Strict no-op without `CAIRN_PLUGINS_DEV=1`.

**To try it:** `CAIRN_PLUGINS_DEV=1 npm run dev`, copy `plugins-template/*` into `<userData>/plugins/` (macOS: `~/Library/Application Support/Cairn/plugins/`), uncomment the `hello-tool` entry in `plugins.yml`, then ask the agent to use the `hello` tool — it appears live.

**Still deferred (Tier 3 proper):** sandbox for untrusted code (`node:vm`/worker — `apply` currently runs with full main privileges), the settings/inventory UI (enable/disable + per-plugin config cards), agent-authored plugins (`dsh-cordis-host-runner` + `dsh-tool-cordis`), and npm-installable plugins (C2). Ungating (removing `CAIRN_PLUGINS_DEV`) requires the sandbox decision first.
## 12. UI PLUGINS + Cairn slot matrix (2026-08-20) — "author a UI plugin, it renders live" ✅

Extends §11 (single toolview embed) into a general **plugin-UI system for Cairn's OWN frontend**: a user/agent authors a UI plugin that draws app chrome (a bouncing cat overlay, a status-bar item, a chat-footer cost widget, a tool view), dropped in via `plugins.yml`, loaded LIVE — no dsh web shell.

### 12.1 The Cairn Slot Matrix (`src/lib/plugin-ui/slot-matrix.ts`)
Cairn's answer to dsh's `SlotMap`: a concrete, closed table of WHERE a plugin may render. A plugin can only mount where Cairn declares + renders a host (declaration = render authorization). Axes: `kind` (list/keyed/single) × `scope` (app/view/thread/turn). Each slot documents its component props (the data contract).

| Slot | kind | scope | host (real DOM) | status |
|---|---|---|---|---|
| `app.overlay` | list | app | `AppOverlayLayer` at page.tsx root (fixed, click-through) | **live** |
| `app.statusbar` | list | app | `AppStatusBar` (renders nothing until populated) | host built, not yet mounted |
| `tool.call.toolview` | keyed | turn | `ToolCallIndicator` (§11) | **live** (SkillRow bridged in) |
| `chat.transcript.footer` | list | thread | chat composer band (cost/context) | declared; host TBD |
| `sidebar.footer` / `view.header.actions` / `settings.section` | list | app/view | declared; hosts TBD |

### 12.2 Architecture
- **Registry** (`registry.ts`): framework-agnostic store + `useSyncExternalStore` so hosts re-render on live register/unregister. `registerSlot(name, {id,key?,order?}, Component)` → disposer.
- **Hosts** (`SlotOutlet.tsx`): `<SlotOutlet>` (list), `<KeyedSlotOutlet>` (keyed), `AppOverlayLayer` (fixed click-through layer, `pointer-events:none`; entries opt back in), `AppStatusBar`. Every plugin component is wrapped in a `PluginBoundary` error boundary — a crashing plugin can't take down the app.
- **Plugin-UI API** (`api.ts`): `activate(ui)` receives `{ React, registerOverlay, registerStatusBarItem, registerChatFooter, registerToolView, register }`. Plugins use `ui.React` (Cairn's single instance — never bundle their own) and never import Cairn internals. Registrations are tracked per plugin id; `deactivateUIPlugin(id)` disposes them (live unload); re-activate = dispose+re-add (clean live edit).

### 12.3 The cross-boundary path (main ⇄ renderer)
A UI plugin's code runs in the RENDERER, but `plugins.yml` + files live under `<userData>/plugins` read by MAIN:
- `plugins.yml` entries gained an optional **`ui:`** field (a renderer file). Backend (`name:`) and UI (`ui:`) entries coexist; the Cordis loader (§10.8) skips `ui:`-only rows.
- **Main** (`electron/ipc/ui-plugin-handlers.ts`): `plugins:listUi` returns each enabled ui-entry's `{id, source}` (raw module text, contained to the plugins dir); an `fs.watch` fires `plugins:ui-changed` on change. Preload exposes `electron.plugins.listUi()` + `onUiChanged`.
- **Renderer** (`loader.ts`): `startUIPlugins()` (called once in page.tsx) pulls sources, evaluates each with `new Function(module, exports, require, React, source)` — a CJS shim whose `require` only resolves `"react"` (Cairn's instance) — into a module exporting `activate(ui)`, and activates it. Re-pulls + re-activates on `plugins:ui-changed` (live reload/unload).

### 12.4 Security posture
The renderer evaluates plugin source (`new Function`) — a code-exec surface, **dev-gated behind `CAIRN_PLUGINS_DEV=1`** exactly like the backend loader. Untrusted-plugin sandboxing (worker isolation / a real boundary) is Tier 3, required before ungating.

### 12.5 Shipped example + verification
- `electron/cordis/plugins-template/bouncing-cat.plugin.js` — a 🐈 that bounces around the screen via `ui.registerOverlay`; click it to speed it up. Plus updated README + `plugins.yml` documenting UI plugins.
- `src/lib/plugin-ui/plugin-ui.component.test.tsx` (**5 tests**): slot matrix shape; a plugin-registered overlay renders + the layer is click-through; deactivate removes it; re-activate dedupes; a crashing plugin is isolated (good sibling still renders).
- Full component suite **149**; §11 DshToolView **6/6** (registry bridge intact); electron **1107**; `next build` clean; renderer + electron tsc clean.

### 12.6 What works now / what needs the full shell (answering "would all dsh plugins work?")
- **Backend plugins (tools/services):** work (§10.8).
- **Self-contained UI** — overlay (bouncing cat), status-bar item, keyed toolview: **work** via this slot system. A dsh UI plugin of this shape ports by mapping its `--dsw-*` tokens (§11 shim) + targeting a Cairn slot.
- **Cost / context widget:** the *widget* is easy (a `chat.transcript.footer` slot), but dsh's own cost plugin reads `useProjection` fed by dsh's connection/session-projection spine — NOT portable as-is. In Cairn it reads **Cairn's** live usage (`chat:usage`/token-meter) via the slot's props. So a user CAN build one, against Cairn's data, not dsh's.
- **Shell-coupled dsh UI** (anything occupying `conversation.*` / needing `useProjection` / the dsh AppFrame): would NOT work without adopting dsh's whole web shell (§9/§B) — out of scope; Cairn keeps its own frontend.

### 12.7 Follow-ups
Mount `AppStatusBar` + build the `chat.transcript.footer` host (unlocks status bar + Cairn-data cost widget); a Plugins settings tab (enable/disable + `slotInventory()`); load real dsh `ui-*` client packages for toolviews (§11.6 #1); the Tier-3 sandbox before ungating.

## 13. dsh ⇄ Cairn slot comparison matrix + alias layer (2026-08-20) ✅

Answers "is Cairn's slot matrix mapped to dsh's slots?" — with a real, checked-in comparison table (`src/lib/plugin-ui/dsh-slot-map.ts`) covering **every production dsh client slot**, each classified against Cairn:

- **`aliased`** — a genuine Cairn equivalent; a dsh plugin registering that name is routed to the Cairn slot. **5 slots:** `shell.overlay`→`app.overlay`, `tool.call.toolview`→`tool.call.toolview` (same name), `conversation.composer.dock`→`chat.transcript.footer`, `sidebar.footer.action`→`sidebar.footer`, `settings.section`→`settings.section` (same name).
- **`cairn-has-different`** — Cairn covers the concern natively (branding, workspace switcher, model picker, attachments, plan UI, message images, per-message nodes) — not via a plugin slot.
- **`shell-only`** — needs dsh's AppFrame/session shell (`root`, `conversation`, `details`, `conversation.session*`, composer internals, hero, slash overlay). No Cairn home without adopting the whole dsh shell (§9/§B). A dsh plugin targeting these is **rejected with a console warning**, not silently broken.
- **`planned`** — a Cairn slot we intend to add (`conversation.session.header.actions`→`view.header.actions`, `conversation.input.dock`, the settings `action`/`plugins.tab`/`general.item`/`plugin.item` family → a Plugins settings tab).

### Alias layer
`resolveSlotName(name)` maps a dsh OR Cairn slot name → a Cairn slot (or null). The plugin-UI API gains **`ui.registerBySlot(slotName, opts, Component)`**: a self-contained dsh UI plugin registering `"shell.overlay"` (or `"conversation.composer.dock"`, etc.) works unmodified; a `shell-only`/unknown name is skipped with a warning pointing at `dsh-slot-map.ts`. `dshCompatSummary()` gives counts for docs / a future Plugins tab.

### What this tells us (the "what's missing" view)
- **The interesting compatibility cases are covered:** the per-tool view (exact-name) + the frame-wide overlay (aliased) — so a dsh "bouncing cat" (`shell.overlay`) or a keyed toolview drops in as-is.
- **The gaps are deliberate:** everything `shell-only` is dsh-shell layout that Cairn doesn't have (and shouldn't fake). `planned` items are the honest backlog (header actions, input dock, the settings-plugins family) — each becomes an alias the moment its Cairn host is mounted.

### Verified
`plugin-ui.component.test.tsx` extended to **9 tests**: a dsh-shaped plugin using `ui.registerBySlot("shell.overlay", …)` renders; `resolveSlotName` maps aliases + native names + rejects `shell-only`/`root`/unknown; a shell-only target is skipped with a warning; the compat summary counts the full inventory (≥30 dsh slots, ≥5 aliased). Component suite **153**; renderer tsc + next build clean.
