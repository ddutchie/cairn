# Running dsh inside Electron — runtime-lookup fixes and the host-process plan

> **Status (2026-09-23):** Stage 1 fixes landed in 3.0.9. Phase 0 is in progress on `feat/agent-host-facade`: all direct `getContext()` calls from Electron IPC and chat/runtime paths now go through `AgentHost`; the remaining work is shared-state/lifecycle façades, non-IPC engine entry points, the boundary guard, and installed/live verification. Stage 2 host process is not started.

## Why this keeps happening

Upstream's desktop app (`deepseek-harness/apps/desktop`) runs the dsh **Host as a separate process**: Electron's executable with `ELECTRON_RUN_AS_NODE=1` (`desktopNodeEnvironment()`), loading dsh **unbundled** from real files outside ASAR. Their design note `.agents/notes/implemented/architecture/2026-09-11-desktop-electron-node-runtime.md` says "Child processes inherit RunAsNode".

Cairn instead **bundles** dsh into `dist-electron/main.js` with esbuild and runs Cordis **in the Electron main process**. That breaks two assumptions dsh is tested with:

1. **`process.execPath` is Node.** In Cairn it's Electron.exe, so `spawn([process.execPath, helper])` boots a second Cairn instead of running the helper.
2. **Files sit next to their module.** `import.meta.resolve`, `new URL("./x", import.meta.url)`, `createRequire(import.meta.url)` and per-platform package lookups resolve relative to the *original* module, which isn't on disk once it's inlined into `main.js` (or is inside `app.asar`, which `spawn` can't execute).

Because we import dsh packages directly, every dsh upgrade can add another site like this.

## Stage 1 — targeted fixes (landed, 3.0.9)

| Symptom | Cause | Fix |
|---|---|---|
| Shell tool output = Chromium cache errors ("app starting") | `dsh-sandbox-local` spawns the Windows ACL runner as `[execPath, runner]` | Runner bundled to `dist-electron/windows-acl-runner.cjs`, pinned via `internals.windowsAclRunnerEntry`; `runWindowsAclRunnerAsNode` (`cordis-coding-tools.ts`) adds `ELECTRON_RUN_AS_NODE` to that spawn only; runner banner deletes it before the user command runs |
| Every subprocess (bash, rg, LSP) booted Cairn in dev; no tree containment when packaged | `dsh-subprocess-local` containment runner (Win32 Job / systemd scope) spawned as `[execPath, runner]`; package not shipped | `electron/subprocess-runner.ts` bootstrap (dsh's `runSelectedSubprocessRunner` API) → `dist-electron/subprocess-runner.cjs`; resolve shim maps the runner to it; `patchSubprocessRunnerEnv` esbuild plugin adds `ELECTRON_RUN_AS_NODE` to `runnerEnvironment` only |
| Glob/Grep fail in the installed app | `@vscode/ripgrep-<platform>-<arch>` not shipped; path inside `app.asar` | Shipped + `asarUnpack`; `@vscode/ripgrep` aliased to `electron/lib/ripgrep-path.ts` (rewrites to `app.asar.unpacked`) |
| Workflows can't start | `dsh-workflow-worker-thread` loads `dist-electron/worker.cjs`, never built | Bundled by `compile-electron.js` |
| Release vs dev bundle drift | `build.js` duplicated esbuild flags; plugins can't be CLI flags | `build.js` runs `compile-electron.js --electron-only` |

**Guard:** `electron/runtime-lookup-guard.test.ts` scans the built bundles for these patterns inside `node_modules` code. Every hit must be in `REVIEWED_RUNTIME_LOOKUPS` with how it's handled; stale entries fail too. It runs in CI (`npm test` compiles first). When it fails after a dsh bump, use the fixes above as the playbook.

## Open items

- [x] **macOS/Linux session lock.** `dsh-session-persistence-jsonl` takes a POSIX `flock` (via `@deepseek-ai/node-addon-system/flock`) right before a session's first log write, loading `bin/system.node` from `@deepseek-ai/node-addon-system-<platform>-<arch>`. electron-builder's own matcher confirmed 3.0.8 didn't ship it. Cairn's chat history lives in SQLite, so sessions still *appear* to persist while dsh logs fail silently. Now shipped + unpacked by an include placed after the `!node_modules/!(…)` exclusion (last match wins).
- [x] **Linux Landlock launcher.** Shipped + unpacked with the same package; `pinLandlockLauncher` (`cordis-coding-tools.ts`) sets `internals.landlockLauncher` to the `app.asar.unpacked` path.
- [x] **Per-arch optional packages.** npm installs only the host CPU's platform packages, but mac/win package both arches from one machine. `scripts/fetch-cross-arch-natives.js` (run by `build.js` before electron-builder) fetches every packaged arch's `@vscode/ripgrep-*` / `node-addon-system-*` with `npm pack`; `after-pack.js` strips the other arch per app. Guard: `runtime-lookup-guard.test.ts` runs `electron-builder.yml` through electron-builder's `FileMatcher`.
- [ ] **Verify on installed builds.** macOS: `npx @electron/asar list …/app.asar | grep node-addon-system`, and `lsof -c Cairn | grep session.lock` while a chat is open. Linux: a sandboxed shell command in workspace-write mode.
- [ ] **dsh-llm version.** `createRequire(...)("../package.json")` resolves to Cairn's `package.json`, so dsh reports Cairn's version in `APP_IDENTITY`. Harmless; fix if it shows up in telemetry or provider headers.
- [ ] **Live verification.** Run a real `npm run dev` agent session (shell, Glob/Grep, terminal tools, subagent, a workflow) and a packaged Windows install.

## Stage 2 — host process (proposed)

Run Cordis/dsh like upstream: a Node-mode child process, dsh loaded unbundled.

```
Electron main (UI process)            Agent host (Electron + ELECTRON_RUN_AS_NODE)
├─ windows, ipcMain handlers          ├─ electron/cordis/* + dsh, loaded unbundled
├─ SQLite (UI reads/writes)    ◄─RPC─►├─ its own SQLite connection (WAL)
├─ bottom-terminal PTYs               ├─ subprocesses, runners, workers (no patches)
└─ shell / dialog / app paths ◄─req── └─ pushes session:event / session:projection
```

Launch with `child_process` + `ELECTRON_RUN_AS_NODE` (the `runtime-server` pattern in `electron/runtime/port-discovery.ts`), not `utilityProcess`, whose children would still see plain Electron.

**Why it's tractable:** the engine (`electron/cordis/`, 46 files, ~11k lines) imports `electron` in only 3 files (`shell.*`, `app.getPath`, `getWin` in `chat-executor.ts`). Renderer pushes are already JSON envelopes (`session:event` / `session:projection`). Model PTYs go through the injectable `PtyAdapter` (`terminal-backend.ts`), so an RPC adapter keeps main as the single PTY owner.

**What makes it work:** the direct `getContext()` reach-ins from IPC, chat, runtime, session-read, and chat-cleanup paths are now behind `AgentHost`. Remaining coupling is shared state read synchronously from main: approval grants, pending-question broker, plan mode, secret grants, chat agent cache, plus turn start/abort and other engine entry points such as automations (`heartbeat-runner.ts`), one-shot AI (`ai-handlers.ts`), UI plugin handlers + install, and `electron/mcp/tools/metadata.ts` (the latter is the workspace/dashboard `window.cairn.getContext()` API, not Cordis context). Plus lifecycle (crash restart, quit teardown, dev watch) and packaging dsh unbundled outside ASAR (bigger app; removes all Stage 1 patches).

| Phase | Work | Estimate |
|---|---|---|
| 0. Facade (one process) | Route `getContext()` callers and shared-state reads through one async `AgentHost` interface; direct IPC migration is complete, lifecycle/shared-state work remains | 1–2 days remaining |
| 1. Host process | Launch/bootstrap (DB, session root, config), request/response + event transport, event forwarding, main-only requests | 3–5 days |
| 2. Remaining surfaces | RPC `PtyAdapter`, approvals/questions, subagent control, plugins, automations, one-shot, MCP metadata | 3–4 days |
| 3. Packaging + hardening | Ship dsh unbundled, crash restart, quit teardown, dev watch, live tests, startup timing | 3–4 days |

≈ 2–3 weeks for one engineer, with Phase 0 partially complete. The direct IPC context migration is done; finish the lifecycle/shared-state façade and guard before deciding on Phases 1–3 around the next dsh minor bump, weighing it against how often the runtime-lookup guard fires.

### Phase 0 checklist

- [x] Define the local async `AgentHost` façade in `electron/cordis/agent-host.ts` and move the direct IPC/runtime/chat `getContext()` callers onto it.
- [x] Route session reads, permissions, goals, schedules, feedback, command execution, prompt previews, tool inventory, chat compaction, titles, and resident-agent cleanup through `AgentHost`.
- [ ] Extend `AgentHost` with turn start/abort, approval decisions, question answers, subagent control, plan/secret state, session stats/replay/export, plugin install, and one-shot AI.
- [ ] Route remaining engine entry points and lifecycle work through the façade: automations, one-shot AI, UI plugin handlers/install, and shared approval/question/plan/secret state.
- [ ] Add a lint rule or guard test ensuring nothing outside `electron/cordis/` imports `run-cordis-loop`'s `getContext`; the current IPC scan is clean.
- [ ] Verify installed macOS/Linux/Windows builds and run the live agent sweep.
