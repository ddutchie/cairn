# Running dsh inside Electron — runtime-lookup fixes and the host-process plan

> **Status (2026-09-23):** Stage 1 fixes landed in 3.0.9. Phase 0 implementation is complete on `feat/agent-host-facade`: direct `getContext()` callers, shared runtime state, automations, runtime-root configuration, turn lifecycle, plugin lifecycle, and quit/dev lifecycle now cross `AgentHost`; the boundary guard and automated checks pass. Cross-OS installed/live verification remains a release-matrix gate. Stage 2 host process is not started.

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
| Workflows can't start | `dsh-workflow-ptc` spawns the PTC bootstrap (`dsh-ptc-runtime-node/lib/process.js`) as `[execPath, process.js]` | Bundled to `dist-electron/process.js` by `compile-electron.js`; `patchPtcRuntimeElectronEnv` adds `ELECTRON_RUN_AS_NODE` to that child's env only (was `dsh-workflow-worker-thread` + `worker.cjs` before 0.1.7) |
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

**What makes it work:** the direct `getContext()` reach-ins from IPC, chat, runtime, session-read, chat-cleanup, and automation paths are now behind `AgentHost`, including turn lifecycle, plugin lifecycle, runtime-root configuration, and the synchronous shared state used by those operations. Plan mode, cold session stats, and export remain engine-owned and are already reached through `AgentHost`; a boundary guard prevents direct imports of those internals. Electron owns the async quit coordinator and the dev supervisor owns graceful process replacement. `electron/mcp/tools/metadata.ts` remains the workspace/dashboard `window.cairn.getContext()` API, not Cordis context. Packaging dsh unbundled outside ASAR remains a later, larger change.

| Phase | Work | Estimate |
|---|---|---|
| 0. Facade (one process) | Route `getContext()` callers, shared-state reads, automations, and lifecycle through one async `AgentHost` interface; automated verification and boundary guard are complete | complete |
| 1. Host process | Launch/bootstrap (DB, session root, config), request/response + event transport, event forwarding, main-only requests | 3–5 days |
| 2. Remaining surfaces | RPC `PtyAdapter`, approvals/questions, subagent control, plugins, automations, one-shot, MCP metadata | 3–4 days |
| 3. Packaging + hardening | Ship dsh unbundled, crash restart, quit teardown, dev watch, live tests, startup timing | 3–4 days |

≈ 2–3 weeks for one engineer, with Phase 0 complete. Decide on Phases 1–3 around the next dsh minor bump, weighing it against how often the runtime-lookup guard fires.

**Phase 0 scope notes (what stays direct by design):** pure helpers with no engine state (`withToolCallView`/`withToolResultView`, `normalizeSubagentScope`), turn-loop invocation with per-turn streaming adapters (`runCordisCodingLoop`/`runCordisLoop` called from the IPC layer — automations already go through `AgentHost.runAutomation`), and main-side plugin file IO (`plugin-loader` manifest YAML + fs watcher in `ui-plugin-handlers.ts`; only the configured root round-trips through the host). The boundary guard (`electron/cordis-boundary-guard.test.ts`) encodes exactly this: stateful modules blocked, pure/file surfaces allowed.

### Phase 0 checklist

- [x] Define the local async `AgentHost` façade in `electron/cordis/agent-host.ts` and move the direct IPC/runtime/chat `getContext()` callers onto it.
- [x] Route session reads, permissions, goals, schedules, feedback, command execution, prompt previews, tool inventory, chat compaction, titles, context-ring reads, one-shot AI, subagent controls, and resident-agent cleanup through `AgentHost`.
- [x] Route synchronous shared runtime state through `AgentHost`: one-shot AI, context-ring reads, subagent controls, pending-question resolution/cleanup/record/list, session grant mutation, trusted approval-arg reads, approval resolver/nonce ownership, confirm-transport bind/unbind, turn controller start/abort ownership, chat-agent drops, and background-job kills.
- [x] Extend `AgentHost` with plugin install/update/uninstall ownership.
- [x] Confirm plan state, cold session stats, and `/export` remain behind the existing `AgentHost` methods rather than adding duplicate façade state.
- [x] Route remaining engine entry points and lifecycle work through the façade: automations, quit teardown, and dev watch. (Crash restart stays scoped to Phase 3 — no crash-restart path crosses the façade today.)
- [x] Add a boundary guard test preventing direct context, plan-state, session-stats, session-export, approval/question/turn/transport/job state access outside `electron/cordis/`.
- [ ] Complete the cross-OS installed-build and live agent sweep as the release-matrix gate; this is validation work, not a remaining code migration.
