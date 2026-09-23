# Running dsh inside Electron — runtime-lookup fixes and the host-process plan

> **Status (2026-09-23):** Stage 1 fixes landed on `fix/windows-shell-subagents-diff` (3.0.9). Guard test in place. Open items and Phase 0 below.

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

- [ ] **macOS/Linux session lock (verify first).** `dsh-session-persistence-jsonl` takes a POSIX `flock` through `@deepseek-ai/node-addon-system/flock`, which loads a native addon from `@deepseek-ai/node-addon-system-<platform>-<arch>`. That package isn't in the `electron-builder.yml` allowlist, and a load failure is re-thrown, so packaged macOS/Linux builds may fail to open sessions. Check on an installed Mac build. Fix: ship `node_modules/@deepseek-ai/node-addon-system-*/**` + `asarUnpack` without shipping all of `@deepseek-ai` (e.g. `@deepseek-ai` in the negation allowlist plus `!node_modules/@deepseek-ai/!(node-addon-system-*)/**`), and install both darwin arches for release builds.
- [ ] **Linux Landlock launcher.** `dsh-sandbox-local` spawns a launcher binary from the same addon package; when packaged, the path is inside `app.asar`. Needs shipping + an `app.asar.unpacked` rewrite (like ripgrep).
- [ ] **Per-arch optional packages on macOS.** npm installs only the host CPU's `@vscode/ripgrep-darwin-*` / `node-addon-system-darwin-*`. An x64 build made on arm64 ships without them. Install both arches (e.g. `npm install --cpu=x64 --os=darwin …` into the staging dir) before packaging.
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

**What makes it work:** ~20 `getContext()` call sites in 6 files hand the live Cordis context to IPC handlers (`session-runtime-handlers.ts` ~1,400 lines). Module-level state is read synchronously from main: approval grants, pending-question broker, plan mode, secret grants, chat agent cache. Other entry points: automations (`heartbeat-runner.ts`), one-shot AI (`ai-handlers.ts`), UI plugin handlers + install, `electron/mcp/tools/metadata.ts`. Plus lifecycle (crash restart, quit teardown, dev watch) and packaging dsh unbundled outside ASAR (bigger app; removes all Stage 1 patches).

| Phase | Work | Estimate |
|---|---|---|
| 0. Facade (one process) | Route `getContext()` callers and shared-state reads through one async `AgentHost` interface | 2–3 days |
| 1. Host process | Launch/bootstrap (DB, session root, config), request/response + event transport, event forwarding, main-only requests | 3–5 days |
| 2. Remaining surfaces | RPC `PtyAdapter`, approvals/questions, subagent control, plugins, automations, one-shot, MCP metadata | 3–4 days |
| 3. Packaging + hardening | Ship dsh unbundled, crash restart, quit teardown, dev watch, live tests, startup timing | 3–4 days |

≈ 2–3 weeks for one engineer. Phase 0 is worth doing on its own: it replaces the `getContext()` reach-ins with a narrow, testable interface. Decide on Phases 1–3 around the next dsh minor bump, weighing it against how often the guard fires.

### Phase 0 checklist

- [ ] Define `AgentHost` (async) in `electron/cordis/agent-host.ts`: turn start/abort, question answer, approval decision, subagent control, session stats/replay/export, plugin install, one-shot.
- [ ] Move `getContext()` callers in `electron/ipc/*` and `electron/mcp/tools/metadata.ts` onto it.
- [ ] Wrap module-level state (approval grants, question broker, plan mode, secret grants) behind it; callers await.
- [ ] Lint rule / guard: nothing outside `electron/cordis/` imports `run-cordis-loop`'s `getContext`.
