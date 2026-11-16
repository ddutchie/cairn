# Plan: shared logic and redundancy refactor (after 3.2.0)

> Status: **executed 2026-11-16** — all of Phase A plus the A8 lint rule landed
> across PRs #285 (A1/A3/A4/A5/A6), #286 (A2), #287 (A7), #288 (A8 agent),
> #289 (A8 session/runtime/embeddings) and the final A8 PR (remaining
> namespaces + `window.electron` boundary lint). Phase B (B1–B6) and Phase C
> (C1–C5) remain open; owner decisions Q1–Q4 are recorded in §7, Q5–Q7 and Q9
> still need research (C4, C5 renames and #179 stay deferred).
>
> Execution log (update with every PR — newest at the bottom):
> - #285 merged — A1/A3/A4/A5/A6 (fixtures, formatters, wire types, docs, prompt fix).
> - #286 merged — A2 (dead LLM transport removal).
> - #287 merged — A7 (renderer dedupe + highlight palette).
> - #288 merged — A8 agent client (+ partial-bridge tolerance fixup).
> - #289 merged — A8 session/runtime/embeddings clients.
> - #290 merged — A8 final namespaces + `window.electron` lint rule (+ review fixups).
> - #291 merged — dead one-shot fallback removal (review follow-up, 1 file).
> - #292 merged — Q6 (pwsh/str_replace_editor out of gating sets).
> - #293 merged — C1 (engine test helpers).
> - #294 merged — C2 (shared tool-name predicates).
> - #295 merged — C3 (one RiskClass, PolicyMode/ApprovalMode; aliases cut pre-merge).
> - #296 merged — B1 (address classifier).
> - Next: B2 (in progress, worktree) → B3 → B4 → B5 → C5-boundary → llm-http.ts (Q9) → knip report-only (Q8) → F20 renames (Q7: after final refactor PR). C4 DROPPED (Q5).
> - Rule: every refactor PR updates this log before merge.

> Status: **proposal**, written 2026-11-15 on `fix/3.2.0-audit-hardening` (PR ddutchie/cairn#284 still open). Investigation only: no code was changed.
> Goal: make the repo easy to edit for coding agents and human collaborators. One home per rule, clear module boundaries, less to keep in sync by hand.
> Scope: `electron/`, `src/`, `shared/`, `scripts/`, `tests/`. `mobile/` is out of scope.

Line numbers are from this branch at commit `d1c7e5b9`. They will drift; re-check before each PR.

## 1. Summary

Measured size (tracked `.ts/.tsx/.js/.mjs`, tests included): `electron/` 390 files / 75.2k lines, `src/` 532 / 88.7k, `shared/` 157 / 22.9k, `scripts/` 19 / 2.9k, `tests/` 9 / 2.9k.

The codebase is in better shape than its size suggests. The earlier refactor wave (PR #174, issues #175–#183) and the UI consistency pass did their job: `jscpd` finds only 24 exact clones (596 lines, 0.35%) in non-test code, there are no `uppercase tracking-*` labels, no Tailwind `shadow-sm…2xl`, 5 arbitrary `text-[N]` sizes, and 2 hand-rolled `absolute … z-50` popovers. Exact copy-paste is not the problem.

The problem is **parallel implementations of the same idea**, mostly in the main process, left behind when the engine replaced the harness:

1. **Two embeddings stacks run side by side** (`electron/embeddings/{client,server,pipeline}.ts` and `electron/runtime/{client,server,adapters/embeddings}.ts`, ~1,900 lines, about 60% the same). Settings installs a model through one and indexing embeds through the other. (F1)
2. **The old LLM transport has no production caller.** `callLLM` and the modules only it reaches (`llm-transport`, `llm-stream`, `lib/responses`, `sse`, `delta-batcher`, the token breakdown) are about 1,250 lines plus their tests. (F2)
3. **Approval and risk exist in three vocabularies** with two different `Mode` types and two `RiskClass` types; "is this a read tool" is written four times and "is this an external tool" three times. (F3)
4. **LLM connection config is resolved five ways** in `electron/ipc/`, with different rules for reusing a cached API key. (F4)
5. **`engine-bridge.ts` is nine jobs in one file** with nine module-level `Map`/`Set`s keyed by session id. Five of them are never cleared. (F5)
6. **Running a child process with timeout, abort and bounded output is written six times**, and running `git` four times. (F6)
7. **"Is this host local or private" is written seven times** with different answers; two of the copies are SSRF guards of different strength. (F7)
8. **The typed IPC client work (#183) stopped part-way**: 347 raw `window.electron.*` calls remain in 104 renderer files, and several wire types are declared on both sides. (F9, F10)

Smaller but cheap: 18 copies of `makeDb()` in tests (47 test files build their own in-memory DB), number/byte formatters written 9 times, and harness names still in live comments and one live prompt.

One likely bug found on the way (not fixed, see F13): the coding prompt tells the model to use a `pwsh` tool on Windows, but the engine registers the shell tool as `bash` on every platform.

## 2. Findings

Risk: how likely a careful extraction changes behaviour. Size: S under 150 changed lines, M 150–500, L over 500.

### Main process

| # | What | Copies (file:lines) | Single home | Risk | Size |
|---|---|---|---|---|---|
| F1 | Two embeddings clients, servers and pipelines | `electron/embeddings/client.ts` (456) vs `electron/runtime/client.ts` (456): jscpd clones at 40–70/47–77, 142–173/115–140, 174–199/153–178, 247–267/231–252, 285–304/269–285. `electron/embeddings/pipeline.ts:51–71, 96–152` vs `electron/runtime/adapters/embeddings.ts:332–352, 265–321`. `electron/embeddings/server.ts` (171) vs `electron/runtime/server.ts` (230). `StdoutEvent` declared in all four. Callers are split: `ipc/embeddings-handlers.ts:207–244` (status, stop, install warm-up) and `main.ts:45,707` use the old client; `embeddings/service.ts:31–34`, `agent/session-search.ts:107`, `ipc/runtime-handlers.ts`, `splash/boot-sequence.ts:228–260` use the runtime client. `scripts/build.js:67,70` and `compile-electron.js:55,65` build both bundles. | Keep `electron/runtime/` as the one process. Move `getDefaultModelId` / `resolveEmbeddingModelId` (`embeddings/client.ts:70,96`) to `electron/embeddings/model-id.ts`; point `embeddings:*` handlers at `runtime/client`; delete `embeddings/{client,server,pipeline}.ts`, the second bundle and `scripts/build-embeddings-binary.js`. | High (packaging, model directories `embedding-models` vs manifest dir, two IPC namespaces) | L |
| F2 | Legacy LLM transport with no production caller | `electron/lib/llm.ts:207–415` (`callLLM`; only reference is the re-export at `ipc/chat.ts:67`, itself unused) and `:416–626` (`TokenBreakdown`, `calculatePromptBreakdown`, `scaleBreakdown`; `TokenBreakdown` is also in `shared/types/chat.ts`). Reached only from `callLLM`: `lib/llm-transport.ts` (237), `lib/llm-stream.ts` (270), `lib/responses.ts` (219), `lib/sse.ts` (53). `lib/delta-batcher.ts` (46) is imported only by its test. One-shots now go through `agent/one-shot.ts` (`ipc/ai-handlers.ts:21`, `ipc/chat.ts:16`). | Delete, keeping `normaliseBaseUrl`, `buildApiUrl`, `isLocalEndpoint`, `LLMConfig`, `OpenAIMessage`, `isSendableMessage` in a slim `llm.ts`. Keep `shared/chat/responses.ts` (mobile uses it). This closes most of open issue #179. | Low once confirmed with the esbuild metafile | L (deletions) |
| F3 | Approval and risk in three vocabularies | Engine: `agent/policy.ts:23` (`Mode = ask\|auto\|yolo\|plan`), `agent/rules.ts:7` (`RiskClass` with `WRITE_CAIRN`), per-tool `risk()` (`agent/tools.ts:21`). Shared/UI: `shared/agent/approval-mode.ts:17` (`Mode = discuss\|plan\|interactive\|auto\|custom`), `shared/agent/tool-risk.ts:13` (`RiskClass` without `WRITE_CAIRN`), name lists at `:33–66`, `riskForTool` `:86–125`. Automations: `lib/automation-approval.ts:24–39` (`READ_TOOL_PREFIXES`, `isExternalTool`, `isReadTool`), `lib/heartbeat-runner.ts:161–174`. Translation layers: `ipc/engine-bridge.ts:49–58` (`engineProfile`), `:71–87` (presets), `:106–111` (`chatEngineProfile`), `agent/tools/cairn.ts:38–43` (`cairnRisk` reads `APPROVAL_SAFE_TOOLS`). Same rule repeated: read prefix `get_/list_/search_` + `codebase_query` at `automation-approval.ts:24–39`, `lib/tool-schemas.ts:333–343`, `src/hooks/useChatStream.ts:131` (inline, twice), plus `READ_TOOLS` at `lib/tool-inventory.ts:21`. External-tool test at `automation-approval.ts:30`, `lib/external-tools.ts:346`, `shared/agent/tool-risk.ts:87`. `CODE_EXEC_TOOLS` at `db/approval-grant-queries.ts:29` and `automation-approval.ts:180` (each comment says it mirrors the other). | `shared/agent/tool-names.ts`: `isExternalToolName`, `isCairnReadTool`, `SHELL_TOOLS`, `CODE_EXEC_TOOLS`. `shared/agent/risk.ts`: the one `RiskClass` (with `WRITE_CAIRN`). Rename the UI type to `ApprovalMode` and the engine type to `PolicyMode`; one `toPolicyMode()` in `electron/agent/profiles.ts` next to `Profile`, replacing the three translation helpers. | High (security path) | M, in stages |
| F4 | LLM connection config resolved five ways | `ipc/session-runtime-handlers.ts:280–345` (`session:prompt`) and `:423–485` (`session:approve-plan`), 37 identical lines by jscpd, both reuse the cached key **without** checking the endpoint. `:545–552` (`session:compact-now`, no cache). `ipc/chat.ts:18–63` (`resolveAIConfig`: reuses the cached key only for the same endpoint, never for local). `ipc/tool-builder.ts:73–93` (`resolveConfig`, cache only). The defaults `"https://api.openai.com"` / `"gpt-5.6-luna"` are literals in 6 main-process files and 8 renderer files. | `electron/lib/llm-config.ts`: `DEFAULT_LLM = { baseUrl, model }`, `resolveConnection(kind: "ai" \| "agent", req)` (one cached-key rule), `resolveAgentLlmConfig(req): { llmConfig: AgentLLMConfig; mode }`. Renderer default goes to `shared/models/defaults.ts`. | Medium (key reuse rule is a behaviour decision, see Q2) | M |
| F5 | `engine-bridge.ts` does nine jobs; session state in nine maps | `ipc/engine-bridge.ts` (727 lines): host singleton `:139–219`, permission presets `:49–103`, chat policy and prompt `:106–121`, grants to rules `:123–135`, questions `:149,230–250`, legacy session cleanup `:284–330`, subagents `:351–460`, prompt assembly `:470–640`, chat/automation/tapped entry points `:643–727`. State: `sessionPlanning:67`, `sessionPreset:77`, `sessionWorkspace:141`, `sessionRules:142`, `sessionTaps:143`, `usageMeta:145`, `observedFiles:146`, `pendingQuestions:149`, `spawnContexts:351`. `forgetEngineSession:399–404` clears only `sessionPlanning` and `spawnContexts`; `sessionWorkspace`, `sessionRules`, `usageMeta`, `observedFiles` and `sessionPreset` have `.set` calls (`:95,365–368,510–525`) and no `.delete` anywhere. | `electron/ipc/engine/`: `host.ts`, `session-state.ts` (one `Map<string, SessionState>` with `get`, `ensure`, `forget(sessionId)` that also drops `<id>.sub-*`), `permissions.ts`, `questions.ts`, `legacy-sessions.ts`, `subagents.ts`, `prompt.ts`, `entry-chat.ts`, `entry-automation.ts`. `engine-bridge.ts` stays as a re-export file so imports do not churn. | Medium | L (moves) |
| F6 | Child process with timeout, abort, bounded output | `agent/tools/bash.ts:75–101`, `agent/jobs.ts:23–43` (same spawn options and the same group-kill line as bash), `agent/hooks.ts:62–79`, `agent/tools/fs.ts:31–46` (rg), `lib/automation-script.ts:215–270`, `lib/coding-tools/bash.ts:169+`. Byte formatter `fmt` copied at `automation-script.ts:85` and `coding-tools/bash.ts:18`. Shell choice differs: `agent/tools/bash.ts:28–29` and `hooks.ts:64` use `powershell.exe` on Windows, `coding-tools/bash.ts:30` finds Git Bash. Git: `ipc/git.ts:72–96` (`git`), `:98–110` (`gitSafe`), `ipc/agent.ts:51–64` (`execGit`, same as `gitSafe` without `getExecEnv()`), plus `agent/sandbox.ts:116` and `agent/host-store.ts:132`. | `electron/lib/proc.ts`: `runProcess({ file, args, cwd, env, stdin, timeoutMs, signal, maxChars, keep: "head" \| "tail", killTree })` returning `{ code, signal, stdout, stderr, timedOut, aborted, truncated }`; `spawnTracked()` for long-lived jobs; `killTree(pid)`; `platformShell(command)`. `electron/lib/git-exec.ts`: `git()`, `gitSafe()`. | Medium-high (sandbox wrapping and kill behaviour must not change) | M |
| F7 | "Is this host local or private" | `lib/llm.ts:58–76` (`isLocalEndpoint`, loopback names only), `agent/tools/web.ts:31–47` (`isPrivateAddress`, full IPv4 + IPv6 incl. mapped/NAT64), `lib/usage-recorder.ts:80–90` (`isLocalHost`, loopback + RFC1918, no link-local), `lib/url-metadata.ts:29–45` (`assertPublicHost`, no IPv6 ranges, no CGNAT), `src/lib/ai-provider-ready.ts:8` (regex), `src/components/settings/endpoint-components.tsx:18–22` (`includes("localhost")`), `src/store/slices/ui-ai-config.ts:597`. Loopback navigation guard copied at `main-window.ts:79–94` and `chat-popout.ts:108–123`. | `shared/net/address.ts` (pure, no Node `net`): `classifyHost(host): "loopback" \| "private" \| "link-local" \| "public" \| "invalid"`, `isLoopbackHost`, `isPrivateAddress`, `isLocalBaseUrl(url)`. `web.ts` keeps its DNS resolution and calls the shared classifier. `electron/lib/window-nav-guard.ts` for the two window guards. | Medium (two SSRF guards; `url-metadata` becomes stricter, which is the point) | M |
| F8 | Session refusals written by hand | `invalid-id` projection + `session:busy` pair: 7 times in `ipc/session-runtime-handlers.ts` (`:219–220, 398–399, 533–534, 576–577, 659, 692, 740`). `already-running` pair: `:254–255, 411–412, 581–582, 597–598, 666–667, 696–697`, `ipc/engine-bridge.ts:485–487, 647–648`. `rejectPrompt` (`engine-bridge.ts:501–505`) already does this plus the `turn/end`, and is used for attachments only. | `electron/ipc/session-guards.ts`: `onSession(channel, handler)` (validates the id once and passes it in), `rejectInvalidId(raw)`, `rejectBusy(sessionId, message?)`. Whether a refusal also ends the turn is decided in one place. | Low-medium | S |
| F11 | Engine boundary is not enforced | Outside code imports 23 different modules under `electron/agent/` by path (`../agent/tools`, `sandbox`, `host`, `host-store`, `route`, `one-shot`, `rules`, `policy`, `loop`, `jobs`, `hooks`, `lsp`, …). The barrel `electron/agent/index.ts` (10 lines) has no importer. In the other direction, AGENTS.md says app I/O goes through `host-store.ts`, but 7 engine files import `../lib`, `../db` directly: `one-shot.ts`, `route.ts`, `session-search.ts`, `terminals.ts`, `tools/cairn.ts`, `tools/cairn-executor.ts`, `tools/skill.ts`. | Make `electron/agent/index.ts` the public surface and add an ESLint `no-restricted-imports` rule in `eslint-rules/cairn.mjs` (outside → only `agent/index`; inside → app code only via `host-store`). Either move the 7 imports behind `host-store` or list them as allowed in the rule with a reason. | Low | M |
| F12 | Dead harness tool | `electron/lib/coding-tools/bash.ts` (264): `bashTool` and `bashToolDefinition` have no importer. Still used from it: `getBashExecutable`, `killProcessTree`, `trackPid`, `untrackPid`, `killTrackedBashProcesses` (`main.ts:40`, `lib/automation-script.ts:29`, `agent/host-store.ts:107`). | Move the five live helpers into `electron/lib/proc.ts` (F6), delete the rest and `lib/truncation.ts` if nothing else needs it. | Low | S |
| F13 | Harness names in live code | `shared/agent/tool-risk.ts:3,18,38–50,66,92–111` (`cairnApprovalPlugin`, `engine-tool-*`, `DSH_WRITE_TOOLS`, `str_replace_editor`, `pwsh`), `shared/agent/approval-mode.ts:66–71`, `lib/tool-inventory.ts:22`, `shared/agent/session-wire.ts:9`, `shared/agent/context-pressure.ts:6`, `shared/session-stats.ts:7`, `agent/provider.ts:2`, `lib/model-pricing.ts:160`, `lib/ripgrep-path.ts:5`, `src/lib/tool-views/{tool-views.css:2,9, primitives.tsx:3}`, `tests/fixtures/ipc-mock.ts:360`. **Likely bug:** `lib/coding-session-prompt.ts:129` tells the model to use `pwsh` on Windows; the registered tool is `bash` everywhere (`agent/tools/bash.ts`). `db/schema.ts:1366–1452` migration comments are history and should stay. | Fix the prompt (own small PR, user-facing, needs a changelog line). Drop `pwsh` / `str_replace_editor` from the live lists once `legacy-import.ts` is confirmed not to depend on them for replayed approvals; rewrite the comments. | Low | S |

### Renderer and shared types

| # | What | Copies (file:lines) | Single home | Risk | Size |
|---|---|---|---|---|---|
| F9 | Raw preload calls | 347 `window.electron.*` uses in 104 non-test files under `src/`. By namespace: `agent` 47, `session` 37, `runtime` 19, `ai` 12, `registry` 11, `command` 11, `platform` 10, `embeddings` 8, `usage` 7, `note` 7, `chat` 7. Typed clients exist only for `automations`, `flow`, `git`, `tools` (`src/lib/ipc/`). Heaviest files: `src/store/index.ts` (14), `settings/EmbeddingsSettings.tsx` (13), `store/slices/commands.ts` (11), `agent/AgentChatPane.tsx` (10). | One client per namespace in `src/lib/ipc/` built on `src/lib/ipc/client.ts`; then a lint rule: `window.electron` only inside `src/lib/ipc/` and `src/store/ipc.ts`. | Low | L, one PR per namespace |
| F10 | Wire types declared twice | `src/types/tools.ts:94–164` re-declares 13 `Registry*` / `*Manifest` types from `shared/chat/registry-schema.ts:43–235`. `src/lib/sync-client.ts:18–98` re-declares `SyncState`, `SyncStatus`, `ConflictCopy`, `PeerProtocol`, `SyncOutcome`, `RestoreRefusal` (`shared/types/sync.ts`, `shared/sync/engine.ts`). `shared/session-stats.ts:24` vs `shared/agent/session-wire.ts:52–84` (`SessionStatsTotals`, `TurnStats`, `SessionStats`). `GoalPhase`: `agent/events.ts:17` vs `session-wire.ts:10`. `SessionTodo`: `src/types/agent.ts:24` vs `session-wire.ts:331`. `PermissionsSelect`, `SubagentScope`: component files vs `session-wire.ts:270,132`. `EmbeddingsStatus`, `EmbeddingsConfig`: `settings/EmbeddingsSettings.tsx` vs `shared/types/embeddings.ts`, `electron/embeddings/types.ts`. `MigrationStatus`, `MigrationProgress`: `layout/MigrationModal.tsx` vs `shared/types/app.ts`. `OpenAIToolDef` ×3 (`lib/external-tools.ts`, `shared/chat/service-exec.ts`, `shared/chat/mcp-namespace.ts`). `IpcResult` means `{ data } \| { error }` in `ipc/result-helpers.ts:23` and `sync/sync-handlers.ts:48`, but `T \| { error }` in `src/types/app.ts:44`. | Declare once in `shared/` and import with `import type`. Rename the renderer one to `IpcUnwrapped<T>` (or delete it if the typed clients make it unused). | Low (types only; `tsc` is the test) | M |
| F14 | Number, byte and time formatters | Tokens as `1.2k`: `settings/OutputBudgetWarning.tsx:4`, `settings/tools/McpToolList.tsx:42`, `agent/ContextRing.tsx:189–194`, `usage/usage-format.ts:12–17`, `shared/chat/message-stats.ts:27–31`. Bytes: `settings/EmbeddingsSettings.tsx:264`, `settings/DataSettings.tsx:35–39`, `lib/automation-script.ts:85–89`, `lib/coding-tools/bash.ts:18–22`. Date-time: `agent/ArchitectureView.tsx:89`, `automations/schedule-builder.tsx:351` (two functions named `formatWhen`), `agent/AgentJobsDock.tsx:31` (`formatElapsed`). 35 `toLocale*String` calls in `src/`. | `shared/format/number.ts`: `formatCompact(n, { upper?: boolean })`, `formatBytes(n, { binary?: boolean })`, `formatDuration(ms)`. Date-times join `shared/format/date.ts` (already has `formatRelative`). | Low (output strings differ slightly today: `k` vs `K`, `MB` rounding; pick per call site with options, do not unify wording silently) | S |
| F15 | Near-identical renderer blocks | `agent/SessionBrowser.tsx:254–349` vs `:501–565` (65 lines); `agent/GitView.tsx:602–638` vs `:653–691`; `notes/notes-view.tsx:637–669` vs `:691–718`; `settings/AISettings.tsx:167–197` vs `settings/AgentSettings.tsx:166–196` (prompt/tools preview panel); `settings/tools/BrowseCommandsModal.tsx:79–96` vs `BrowseCommunityModal.tsx:101–118`; `automations/automation-detail-dialog.tsx:109–127` vs `automation-dev-modal.tsx:64–82`; `agent/SessionBrowser.tsx:199–217` vs `chat/SessionPopoutView.tsx:134–152`; `store/slices/chat.ts:318–332` vs `:448–462`; `store/slices/terminal-sessions.ts:506–520` vs `:539–553`. | Local extraction in each folder (for example `settings/PromptPreviewPanel.tsx`, a `SessionRow` in `agent/`); the browse modals already share `ui/catalog-browser-shell.tsx`, finish moving the list body into it. | Low | M |
| F16 | Second syntax palette with raw hex | `agent/DiffFile.tsx:16–36` hard-codes `PALETTE_DARK`/light hex values and its own `HastNode` + `renderHast` (`:38–60`); `notes/CodeBlock.tsx:31–60, 98–120` builds the same thing from the shared `SYNTAX_COLORS` (`shared/notes/syntax-palette.ts`). | `src/lib/highlight/render-hast.tsx` exporting `renderHast` and `usePalette()`; `DiffFile` uses the shared tokens (also fixes the "no raw colours" rule). | Low (visual check in both themes) | S |

### Tests

| # | What | Copies | Single home | Risk | Size |
|---|---|---|---|---|---|
| F17 | In-memory DB fixture | `function makeDb()` in 18 test files (for example `electron/db/queries.test.ts:80`, `ipc/handlers.test.ts:25`, `lib/heartbeat-runner.test.ts:61`); 47 test files construct `new Database(":memory:")` + `applySchema`. Seed helpers repeat too (`seed`, `seedWorkspace`). | `electron/test-support/db.ts`: `makeDb()`, `seedWorkspace(db, id?)`, `seedProject(db, …)`. | Low | M (mechanical) |
| F18 | Engine test helpers | `call` + `toolUse` at `agent/loop.test.ts:14,17` and `agent/host.test.ts:15–16`; `call` again at `agent/hooks.test.ts:63`; `tick`/`until` at `agent/host.test.ts:17,19` and `agent/jobs.test.ts:4`. `agent/test-harness.ts` (exports `makeTools`, `makeHarness`, `drive`, `types`, `ofType`, `toolResults`) is imported by 8 files but has none of these. | Add `call`, `toolUse`, `tick`, `until` to `electron/agent/test-harness.ts`. | Low | S |
| F19 | Other repeated fixtures | `src/store/slices/selectors.memo.test.ts:17–58` vs `selectors.test.ts:9–50` (42 lines); secure-store mock in `lib/mcp-oauth.test.ts:11–34`, `lib/secure-store.test.ts:12–32`, `lib/service-oauth.integration.test.ts:22–45`; tool-schema fixtures in `lib/tool-error-audit.test.ts:20–39`, `lib/tool-schema-optimization.test.ts:29–49`, `lib/prompt-optimization.test.ts:38–51`; `src/store/slices/ui.test.ts` repeats its own setup block 10 times (`:20–32`). | `src/store/slices/test-support.ts` (store fixture), `electron/test-support/secure-store-mock.ts`, `electron/test-support/tool-fixtures.ts`; a `beforeEach` in `ui.test.ts`. | Low | S |

### Navigation and docs

| # | What | Evidence | Fix | Risk | Size |
|---|---|---|---|---|---|
| F20 | Same file name, different job | `tools.ts` ×8 (`electron/agent/tools.ts` next to the folder `electron/agent/tools/`, `electron/lib/tools.ts` holds the chat system prompt, `electron/ipc/tools.ts`, `electron/preload/tools.ts`, `src/lib/ipc/tools.ts`, `src/store/slices/tools.ts`, `src/types/tools.ts`, `shared/types/tools.ts`). `tool-builder.ts` in both `electron/lib` and `electron/ipc`; `url-metadata.ts` in both; `spellcheck.ts` in `electron/` and `electron/ipc/`. Two types named `Mode`, two `RiskClass`, two `IpcResult` (F3, F10). | Rename the three that mislead most: `electron/agent/tools.ts` → `agent/tool-types.ts`; `electron/lib/tools.ts` → `lib/chat-prompt.ts`; IPC registrars get a `-handlers` suffix like their neighbours (`ipc/tools-handlers.ts`, `ipc/tool-builder-handlers.ts`, `ipc/url-metadata-handlers.ts`, `ipc/spellcheck-handlers.ts`, `ipc/git-handlers.ts`, `ipc/agent-handlers.ts`, `ipc/chat-handlers.ts`). | Low (rename only) | M |
| F21 | AGENTS.md gaps | The "Styling rules" section carries the better-sqlite3 and onnxruntime bullets. "Key constraints" is an empty heading (`AGENTS.md:162`). The store table lists 9 slices; `src/store/slices/` has 18 (missing `automations`, `coding-agents`, `commands`, `notifications`, `session-prompt-guard`, `terminal-sessions`, `user-style`, and the three `ui-*` parts are only named in passing). A sentence refers to "better-sqlite3 ABI above", a heading that no longer exists. No map of where shared logic lives. | Section 5 below. | None | S |
| F22 | Retired plans read as current | `docs/plans/cordis-runtime.md` (992 lines), `dsh-0.1.2-alpha.3-evaluation.md`, `electron-host-runtime.md`, `unified-agent-session.md`, `remove-dsh.md`, `docs/approval-gating-audit.md`. Each has a "Historical" banner, but they sit beside the live design and match most searches for approvals and sessions. | Move to `docs/archive/` and add a `docs/plans/README.md` index marking which plans are current. | None | S |
| F23 | No unused-code check | `npx knip` with no config reports 266 "unused files" because it cannot see the Electron entry points, so its output is noise (it also wrongly flags `d3-zoom`, `cmdk`). Its real hits were confirmed by hand: F2, F12, and the `ai` package (`package.json:126`, no import in `electron/`, `src/`, `shared/`, `scripts/`). | Add a `knip.json` with the real entries (`electron/main.ts`, `electron/preload/*`, the three server bundles, `electron/mcp-server.ts`, Next app, scripts) and run it in CI in report-only mode first. | Low | S |

## 3. Phased plan

Every PR: `npm run type-check:all`, `npm run compile`, `npx vitest run`, eslint on touched files. No version bump. A changelog line only where marked user-facing.

"After #284" means the PR touches approval, sandbox, SSRF or session-runtime code that #284 is changing, so it must branch from `main` after that merge.

### Phase A: safe now (no overlap with #284)

**PR A1. Test fixtures for the DB (F17, F19)**
- Scope: add `electron/test-support/db.ts`, `secure-store-mock.ts`, `tool-fixtures.ts`, `src/store/slices/test-support.ts`; switch the 18 `makeDb` files and the fixture copies to them.
- Files: test files only, outside `electron/agent/` (leave `agent/host-store.test.ts` for C1).
- Protection: the tests themselves. Test count before and after must match.
- Must not change: any production file.

**PR A2. Remove the dead LLM transport (F2, F12 part, F23 part)**
- First: build with the esbuild metafile and confirm `llm-transport`, `llm-stream`, `lib/responses`, `sse`, `delta-batcher` are not in `dist-electron/main.js`. Confirm `mobile/` imports `shared/chat/responses.ts` only.
- Scope: delete `callLLM` and the token breakdown from `electron/lib/llm.ts`; delete the five modules and their tests (`llm-transport.test.ts`, `llm-stream.test.ts`, `responses.test.ts`, `delta-batcher.test.ts`, `token-breakdown-images.test.ts`, `llm-sendable.test.ts` only if `isSendableMessage` goes too). Move the live tests that exercise them (`responses.live.test.ts`, `protocol-benchmark.live.test.ts`, `temperature-ab.live.test.ts`) onto `agent/provider.ts` or delete them (Q4). Remove the `callLLM` re-export at `ipc/chat.ts:65–67`. Remove the `ai` dependency.
- Protection: `electron/bundle-guard.test.ts`, `electron/pipeline-regression.test.ts` (imports `iterSseData`; rewrite or drop that case), `agent/provider.test.ts`, `agent/one-shot.test.ts`, `ipc/ai-handlers.test.ts`.
- Must not change: one-shot behaviour, `normaliseBaseUrl` / `buildApiUrl` output (`lib/llm-url.test.ts`).

**PR A3. Formatters (F14)**
- Add first: `shared/format/number.test.ts` pinning today's exact strings for each call site.
- Scope: `shared/format/number.ts`; replace the 9 local copies and the two `formatWhen`.
- Must not change: any rendered string (use options to keep `k`/`K` and rounding as they are).

**PR A4. Wire types declared once (F10)**
- Scope: delete the renderer re-declarations and import from `shared/`; rename renderer `IpcResult`.
- Files: `src/types/tools.ts`, `src/lib/sync-client.ts`, `src/types/agent.ts`, `shared/session-stats.ts`, the component files listed in F10. `electron/agent/events.ts` (`GoalPhase`) waits for C-phase.
- Protection: `tsc` (both projects), `electron/ipc/contract.test.ts`, `electron/agent/session/contract.test.ts`.
- Must not change: any runtime code; `import type` only.

**PR A5. Docs and guard rails (F21, F22, F23)**
- Scope: AGENTS.md changes from section 5, `docs/archive/`, `docs/plans/README.md`, `knip.json` in report-only CI.
- Note: `next dev` rewrites the first block of AGENTS.md; keep it as is.

**PR A6. Coding prompt names the wrong shell tool on Windows (F13 bug)** — user-facing, changelog line.
- Scope: `electron/lib/coding-session-prompt.ts:129`. Add a case to `lib/coding-session-prompt.test.ts` asserting every tool named in the prompt is in the coding toolset from `lib/tool-inventory.ts`.

**PR A7. Renderer block dedupe (F15, F16)**
- Scope: the component pairs in F15 and the diff palette. Can be split per folder.
- Protection: `*.component.test.tsx` under `src/components/ui/`, Playwright screenshots (`tests/e2e/screenshots.spec.ts`) for before/after, both themes for F16.

**PR series A8. Typed IPC clients (F9)**
- One PR per namespace, largest first: `agent`, `session`, `runtime` + `embeddings`, then the rest. Last PR adds the lint rule.
- Protection: `tests/fixtures/ipc-mock.ts`, store slice tests.
- Must not change: channel names or payloads (`shared/ipc/contract.ts` untouched).

### Phase B: after #284, main process outside the policy core

**PR B1. Local/private address classifier (F7)**
- Add first: `shared/net/address.test.ts` built from the cases in `electron/agent/tools/tools.test.ts` (web_fetch section) plus one table row per current caller showing its answer today.
- Scope: `shared/net/address.ts`; `agent/tools/web.ts` keeps DNS resolution and imports the classifier; `lib/llm.ts`, `lib/usage-recorder.ts`, `lib/url-metadata.ts`, three renderer sites; `lib/window-nav-guard.ts` for `main-window.ts` and `chat-popout.ts`.
- Must not change: `web_fetch` refusals (same inputs refused). Stated change: `url-metadata` refuses more (IPv6 private ranges, CGNAT, link-local); usage "local" labelling may change for link-local hosts, decide per Q3.

**PR B2. LLM config resolution (F4)**
- Add first: `electron/lib/llm-config.test.ts`, a table test that records today's output of the five resolvers for: key present, key absent + cache same endpoint, key absent + cache other endpoint, local endpoint, `mode` vs `autoApprove` precedence, temperature `0`.
- Scope: `electron/lib/llm-config.ts`; call it from `session-runtime-handlers.ts` (three handlers), `chat.ts`, `tool-builder.ts`, and the default literals in `ai-handlers.ts`, `flow-handlers.ts`, `user-style-handlers.ts`.
- Must not change: mode precedence (`session-runtime-handlers.ts:316–326`), "temperature is renderer-authoritative", keychain ref resolution. The cached-key rule for agent sessions changes only if Q2 says so, in a separate commit.

**PR B3. Session guards (F8)** — after B2 (same file).
- Scope: `electron/ipc/session-guards.ts`; replace the 15 hand-written refusals.
- Add first: a test in `ipc/chat-session.test.ts` or a new `session-guards.test.ts` asserting the exact events each refusal emits today (some end the turn, most do not).
- Must not change: event order and payloads seen by the renderer (`src/store/slices/session-prompt-guard.ts` depends on them).

**PR B4. Split `engine-bridge.ts` and unify session state (F5)** — after B3.
- Step 1 (move only): create `electron/ipc/engine/*`, keep `engine-bridge.ts` re-exporting everything. No logic edits.
- Step 2: replace the nine maps with `session-state.ts`; `forgetEngineSession` calls `forget()`.
- Add first: a test in `ipc/engine-bridge.test.ts` that runs a turn, destroys the session and asserts no state remains for it or its `.sub-*` children.
- Must not change: when state is dropped for live sessions (a session that is only idle keeps its preset and rules). Stated change: destroyed sessions no longer leak five entries.

**PR B5. Process helper (F6, F12)**
- Add first: `electron/lib/proc.test.ts` (timeout kills the group, abort, tail truncation, stdin, exit code and signal reporting) using real short commands, as `agent/jobs.test.ts` does.
- Scope: `electron/lib/proc.ts`, `electron/lib/git-exec.ts`; adopt in `agent/hooks.ts`, `agent/tools/fs.ts`, `lib/automation-script.ts`, `ipc/git.ts`, `ipc/agent.ts` first; then `agent/jobs.ts` and `agent/tools/bash.ts` in a second commit. Delete `lib/coding-tools/bash.ts`.
- Protection: `agent/sandbox.test.ts`, `agent/jobs.test.ts`, `agent/hooks.test.ts`, `agent/tools/tools.test.ts`, `lib/automation-script.test.ts`, `ipc/agent.test.ts`.
- Must not change: the argv passed to `wrapSandboxed`, the env of sandboxed commands, the result text of `bash` (`[timed out after …]`, `[exit N]`, sandbox denial hint), which shell hooks run in.

**PR B6. Embeddings: one stack (F1)** — needs Q1 answered first.
- Add first: a test for `embeddings:status` / `embeddings:models:install` against a fake runtime client, and a packaged-build smoke check on mac arm64 + x64 (onnxruntime pin).
- Scope: as in F1. Renderer `EmbeddingsSettings.tsx` moves to one namespace.
- Must not change: where installed models live on disk (or migrate them), embedding output (section hashes depend on it), the standalone `cairn-mcp` path that avoids `embeddings/client.ts` (`mcp/tools/graph.ts:283`).

### Phase C: after #284, approval and engine core

**PR C1. Engine test helpers (F18)** — tests only under `electron/agent/`.

**PR C2. Tool-name predicates (F3, first stage)**
- Add first: `shared/agent/tool-names.test.ts` asserting, for every name in `TOOL_SCHEMAS` plus the engine toolset from `lib/tool-inventory.ts`, that the new predicate equals each old one.
- Scope: `shared/agent/tool-names.ts`; replace the four read-prefix copies, three external-tool copies, two `CODE_EXEC_TOOLS`.
- Must not change: any allow/ask outcome. `lib/automation-approval.test.ts`, `lib/heartbeat-runner.test.ts`, `db/approval-grant-queries.test.ts`, `shared/agent/tool-risk.test.ts` stay green unchanged.

**PR C3. One `RiskClass`, two clearly named modes (F3, second stage)**
- Scope: `shared/agent/risk.ts`; `agent/rules.ts` imports it; rename `Mode` → `PolicyMode` (engine) and `ApprovalMode` (UI/config); move `engineProfile`, `presetProfile`, `chatEngineProfile` into `electron/agent/profiles.ts`.
- Protection: `agent/policy.test.ts`, `policy.external.test.ts`, `rules.test.ts`, `sandbox.test.ts`, `reviewer.test.ts`, `ipc/engine-bridge.test.ts`, `src/lib/tool-risk.test.ts`.
- Must not change: `decide()` and `rules.ts` logic (types and names only). Persisted values (`mode` in the config cache, grant rows) keep their strings.

**PR C4. Automation approvals as engine rules (F3, third stage, optional)** — see Q5.
- Scope: express `shouldAutoAllowAutomationTool` (`heartbeat-runner.ts:161–174`) and standing rules as `Rule[]` passed in the automation profile, so `decide()` is the only decision point.
- Add first: a table test that runs every row of today's matrix (mode × tool kind × standing rule × connector-aware) through both paths.
- Risk: high. Do last, alone.

**PR C5. Engine boundary (F11) and renames (F20)**
- Scope: public `electron/agent/index.ts`, the lint rule, the file renames. Rename-only commits, separate from logic.
- Protection: `tsc`, `electron/bundle-guard.test.ts`.

### Suggested order

A1 → A2 → A5 → A6 (quick wins, in any order) · A3, A4, A7, A8 alongside · then, once #284 is merged: B1 → B2 → B3 → B4 → B5 → C1 → C2 → C3 → C5 → B6 → C4.

## 4. What can run in parallel

Groups that touch disjoint files:

- **Group 1 (tests):** A1. Later C1.
- **Group 2 (main, lib):** A2, then B1 (both edit `electron/lib/llm.ts`, so in that order).
- **Group 3 (renderer):** A3, A7, A8 in parallel with each other if A8 PRs avoid the files A7 is editing (`SessionBrowser.tsx`, `GitView.tsx`, `AISettings.tsx`, `AgentSettings.tsx`). A3 touches `EmbeddingsSettings.tsx` and `DataSettings.tsx`; do those before the A8 `runtime`/`embeddings` PR.
- **Group 4 (types):** A4 touches `src/types/*` and `src/lib/sync-client.ts`; parallel with everything except A8 PRs for the same namespace.
- **Group 5 (docs):** A5, A6 any time.
- **Strictly sequential:** B2 → B3 → B4 (all in `session-runtime-handlers.ts` / `engine-bridge.ts`); C2 → C3 → C4 (approval files); B5 before C5's renames of `ipc/git.ts` and `ipc/agent.ts`.
- **B5 and B1** both touch `agent/tools/` but different files (`bash.ts`, `fs.ts` vs `web.ts`): parallel is fine.
- **B6** is independent of everything except the A8 `embeddings`/`runtime` client PR; do A8's first.

## 5. Proposed AGENTS.md additions

Move the two native-module bullets (better-sqlite3, onnxruntime) out of "Styling rules" into a new "Native modules" section, delete the empty "Key constraints" heading, replace "better-sqlite3 ABI above" with "Native modules above", and complete the store table. Then add:

```markdown
## Where things live

Before writing a helper, look here. If the thing exists, use it; if it almost fits, extend it.

| Concept | Home | Notes |
|---|---|---|
| Domain and wire types | `shared/types/`, `shared/agent/session-wire.ts`, `shared/chat/registry-schema.ts` | Renderer and main import these with `import type`. Never re-declare a wire type in `src/`. |
| IPC channels and payloads | `shared/ipc/contract.ts` | Main registers with `registerContractHandle` (`electron/ipc/registry.ts`); renderer calls through `src/lib/ipc/<namespace>.ts`. |
| IPC result envelope | `electron/ipc/result-helpers.ts` (`handle`) | Main returns `{ data } | { error }`; the typed client unwraps it. |
| Dates and relative time | `shared/format/date.ts` | |
| Numbers, tokens, bytes, durations | `shared/format/number.ts` | |
| Error to message | `errMsg` (`electron/host-shared/errors.ts`) | |
| Markdown to text, wikilinks | `shared/notes/text.ts`, `shared/notes/wikilinks.ts` | |
| Local / private host checks | `shared/net/address.ts` | Any new fetch of a user- or model-supplied URL must use it. |
| LLM base URL, defaults, connection config | `electron/lib/llm.ts` (`normaliseBaseUrl`, `buildApiUrl`), `electron/lib/llm-config.ts` | Do not read `getCachedConfig()` for a key or model outside `llm-config.ts`. |
| Model calls | `electron/agent/provider.ts` (streaming), `electron/agent/one-shot.ts` (single reply) | There is no other transport. |
| Tool schemas (Cairn data tools) | `electron/lib/tool-schemas.ts` (`TOOL_SCHEMAS`) | |
| Per-surface toolsets | `electron/agent/tools/index.ts` (`buildToolset`), shown by `electron/lib/tool-inventory.ts` | |
| Tool name predicates (read, external, shell) | `shared/agent/tool-names.ts` | |
| Risk class and approval decision | `shared/agent/risk.ts`, each tool's `risk()`, `electron/agent/policy.ts` (`decide`), `electron/agent/rules.ts` | `decide()` is the only place an allow/ask/deny is computed. |
| UI approval mode → engine profile | `electron/agent/profiles.ts` | |
| Shell sandbox | `electron/agent/sandbox.ts` | |
| Running a child process | `electron/lib/proc.ts` (`runProcess`, `spawnTracked`, `killTree`), `electron/lib/git-exec.ts` | No bare `spawn`/`execFile` elsewhere. |
| Per-session engine state | `electron/ipc/engine/session-state.ts` | No new module-level `Map` keyed by session id. |
| Session refusals (busy, invalid id) | `electron/ipc/session-guards.ts` | |
| Embeddings process | `electron/runtime/` | |
| DB access | `electron/db/*-queries.ts` on the handle from `electron/db/client.ts` | |
| UI primitives | `src/components/ui/` | See "Styling rules". |
| Viz hooks and colour helpers | `src/lib/viz/` | |
| Syntax highlight colours | `shared/notes/syntax-palette.ts`, `src/lib/highlight/` | |
| Test fixtures | `electron/test-support/` (DB, mocks), `electron/agent/test-harness.ts` (engine), `src/store/slices/test-support.ts`, `tests/fixtures/` (e2e) | |

## Rules that keep it that way

- **Search before you write.** For any parser, validator, formatter, id/path check or config lookup, search `shared/` and the table above first. A second copy "kept local to avoid a dependency" is not allowed; move the original to `shared/` instead.
- **Pure logic used by both processes goes in `shared/`** (no Electron, no Node-only APIs). Main-only helpers go in `electron/lib/`. Renderer-only helpers go in `src/lib/`.
- **A comment that says "mirrors X" is a bug report.** Import X.
- **`electron/agent/` is the engine.** Code outside it imports from `electron/agent/index.ts` only. Code inside it reaches app code only through `host-store.ts`.
- **The renderer never touches `window.electron` directly** outside `src/lib/ipc/` and `src/store/ipc.ts`.
- **IPC registrar files are named `<domain>-handlers.ts`**; the logic they call lives in `electron/lib/` under the plain name.
- **No new module-level mutable state keyed by session, thread or workspace id** without a single `forget(id)` that clears it, called from the delete path.
- **Tests take fixtures from the test-support modules.** Do not declare `makeDb`, `call`, `toolUse`, `tick` or `until` in a test file.
- **Retired names stay out of live code.** `cordis`, `dsh`, `engine-tool-*`, `pwsh`, `str_replace_editor` belong only in `electron/agent/session/legacy-import.ts`, migrations and `docs/archive/`.
- **Plans in `docs/plans/` are current or marked.** When a plan is finished or dropped, move it to `docs/archive/`.
```

(The table names several modules that do not exist yet; add each row in the PR that creates the module.)

## 6. Looked at and left alone

- **`electron/db/schema.ts` (1,854 lines).** Append-only migrations. Its Cordis comments are the history of those migrations. Splitting it buys nothing and risks reordering.
- **`shared/ipc/contract.ts` (1,142) and `shared/sync/engine.ts` (1,584).** Each is the single source for its concept and well tested. Size alone is not a reason.
- **`electron/agent/host-store.ts` re-exports (14 lines of them).** That is the intended façade.
- **`electron/agent/session/legacy-import.ts`.** Must keep the old names to read old logs.
- **Small re-export files** (`src/types/*.ts`, `src/lib/tool-risk.ts`, `electron/embeddings/{cosine,sections}.ts`, `electron/host-shared/text-utils.ts`). Harmless path stability; `knip` in CI will show when one has no importer left.
- **Large renderer components** (`notes/note-editor.tsx` 983, `flow/flow-view.tsx` 945, `layout/project-overview/index.tsx` 923, `chat/chat-panel/index.tsx` 891, `graph/ForceGraphCanvas.tsx` 873). Issue #177 already split them once; what is left is mostly one component with its hooks. Only the internal clones in F15 are worth touching now.
- **`SimNode`/`SimLink` in `agent/ArchitectureGraphCanvas.tsx` vs `graph/force-layout.ts`.** Same names, different node shapes. Not a duplicate.
- **`type Props` in 30 component files, `Row`/`Args`/`Pending` in a few modules.** Local names, not shared shapes.
- **`shared/sync/line-diff.ts:32–48` vs `merge3.ts:39–55`** (17-line LCS table). Small, stable, and sync code is the wrong place for a drive-by.
- **`scripts/capture-screenshots.ts:126–140` vs `scripts/demo-record.ts:172–186`** and their hard-coded `seenFeatures` id lists (also in `tests/e2e/screenshots.spec.ts:103`). Tooling; fix only if the lists cause a failure.
- **`electron/lib/tool-builder.ts` logic and `electron/lib/mcp-oauth.ts` (828).** Cohesive; only the file-name clash (F20) matters.
- **Styling rules.** Checked: 0 `uppercase tracking-*`, 0 Tailwind shadow sizes, 5 arbitrary text sizes, 3 `rgba(`, 2 hand-rolled popovers (`chat/ChatInput.tsx`, `agent/DependencyMatrix.tsx`), 88 `title="…"` attributes. The lint rule and the consistency pass are working; the 88 `title=` are worth a later look but are not shared-logic work.
- **`mobile/`.** Not surveyed beyond confirming it depends on `shared/chat/responses.ts`.
- **`opencode` identifiers** (`electron/lib/cairn-identity.ts`, `shared/agent/app-identity.ts`). These are provider-identity headers in use, not harness leftovers.

## 7. Open questions for the owner

> Decisions 2026-11-16: Q1 remove the `cairn-embeddings` binary once verified unused (B6 proceeds on that basis — `electron/runtime/` is the survivor). Q2 unify on the chat rule: agent sessions must refuse a cached key for a different endpoint, own commit (security angle). Q3 agent's choice: keep two named predicates (`isLoopbackHost` for "needs no key", `isPrivateAddress` for "must not fetch") — usage labelling and fetch refusal are different decisions; conflating them risks leaking keys or over-blocking. Q4 accepted: live tests of the old transport deleted with it in A2. Q5 DROP C4 (owner-confirmed 2026-11-16: keep the separate automation gate). Q6 REMOVE `pwsh`/`str_replace_editor` (done, #292). Q7 renames land after the FINAL refactor PR merges, so no open refactor work conflicts (owner decision 2026-11-16 — supersedes the 3.2.0 gate). Q8 knip report-only approved — queue knip.json + non-blocking CI step. Q9 do the `llm-http.ts` helper now (after B2 merges — it touches the same handler files); close only the token-breakdown checkbox on #179.
>
> A8 closed 2026-11-16: one typed client per namespace in `src/lib/ipc/`
> (`agent`, `session`, `runtime` + legacy `embeddings`, `ai` + `usage`,
> `registry`, `commands`, `platform`, `note`, `chat`, `board` (column/card),
> `workspace`/`project`/`tag`/`changes`, `sync`, `userStyle`, `toolBuilder`,
> `app`, `automation` deltas) and the `window.electron` boundary lint rule
> (`no-restricted-syntax`, allowed only in `src/lib/ipc/` + `src/store/ipc.ts`;
> tests/fixtures exempt). All `window.electron` call sites migrated; no
> intentional behavior changes (off-Electron paths preserved or made explicit).
>
> Research 2026-11-16 (see subagent briefs; #284 is MERGED so the C-phase gate
> is open — branch C-work from current `main`):
> - Q5 → DROP C4. The automation gate is only a pre-filter in the tap; engine
>   `RuleMatch` cannot express target-scoped standing rules or the
>   `run_script`-always-gated invariant, and folding would erase the tap's
>   second-opinion re-ask. C2's shared predicates fix the real drift. (Owner to
>   confirm in follow-up session.)
> - Q6 → REMOVE `pwsh`/`str_replace_editor` from gating sets. `legacy-import`
>   stamps replayed calls `risk: "READ"` and never consults risk on replay;
>   nothing registers those tools live; worst case falls through to the
>   unknown-tool default (still asks). Keep display fallbacks; pin with a test.
> - Q7 → DEFER F20 renames until after the 3.2.0 release (package.json still
>   3.1.7, changelog staged). Rename-only commits when the stack is flattest.
>   The C5 boundary-lint half (`agent/index.ts` surface) may go earlier.
> - Q9 → KEEP #179 OPEN, descoped to a shared HTTP helper. Token-breakdown
>   half is done (A2). Five Bearer+fetch sites remain with disagreeing
>   timeouts → new `electron/lib/llm-http.ts` (`authHeaders` + `fetchJson`).

1. **Embeddings (F1).** Is `electron/runtime/` the intended survivor, and may the standalone `cairn-embeddings` binary and the `embeddings:*` IPC namespace go? Today "install model" warms the old worker (`ipc/embeddings-handlers.ts:244`) while indexing uses the runtime process: is that a known double load?
2. **Cached API key reuse (F4).** Chat refuses to reuse a cached key for a different endpoint (`ipc/chat.ts:37–52`); agent sessions do not check (`ipc/session-runtime-handlers.ts:293–307`). Should agent sessions get the chat rule? This is a behaviour change with a security angle, so it should be its own commit.
3. **Address classes (F7).** Should usage accounting treat link-local and CGNAT hosts as "local" the way the SSRF guard treats them as non-public, or keep two named predicates (`isLoopbackHost` for "needs no key", `isPrivateAddress` for "must not fetch")?
4. **Live tests of the old transport (A2).** Port `responses.live.test.ts`, `protocol-benchmark.live.test.ts`, `temperature-ab.live.test.ts` to `agent/provider.ts`, or delete them?
5. **Automation approvals (C4).** Is folding the automation gate into engine `Rule`s wanted, or should automations keep their own gate and only share the predicates (C2)?
6. **`pwsh` and `str_replace_editor` (F13).** Can old imported sessions still raise approval cards for these names? If yes they stay in `tool-risk.ts` with a comment saying why.
7. **File renames (F20).** Acceptable churn for open branches, or only after 3.2.0 ships and #284 lands?
8. **Unused-code check (F23).** OK to add `knip.json` and a CI step (report-only first)?
9. **Issue #179** (shared LLM HTTP helper). After A2 only `ipc/ai-handlers.ts`, `ipc/tool-builder.ts`, `lib/tool-builder.ts`, `lib/bench-endpoint.ts` and `lib/provider-credits.ts` still build a Bearer request by hand. Close #179 into A2, or keep it for a small `lib/llm-http.ts`?

## 8. How this was measured

- Line and file counts: `git ls-files … | xargs wc -l`.
- Clones: `npx jscpd@4` (min 12 lines / 90 tokens for code, 8 / 70 for tests), reports kept outside the repo.
- Unused code: `npx knip@5` without config (noisy, see F23); every item cited above was confirmed with a search for importers.
- Everything else: ripgrep for definitions and call sites, then reading the cited ranges.
- Earlier work checked so this does not repeat it: PR #174; issues #175, #176, #177, #178, #180, #181, #182, #183 (closed) and #179 (open); `docs/plans/remove-dsh.md`, `agent-engine-design.md`, `ui-consistency-pass.md`; `docs/architecture-review.md`.
