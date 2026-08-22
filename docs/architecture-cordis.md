# Cairn ↔ Cordis/DSH Architecture

Living reference for how Cairn's agent runtime is composed on the dsh/Cordis
engine, how the parts talk to each other, how to keep the stack up to date, and
what is still open after the `feat/cordis-runtime` refactor.

> scope: electron main + renderer. The runtime is Cordis (the engine), dsh
> provides the agent/session/tools stack, Cairn owns the UI, DB, tools bridge
> and plugin system. `docs/plans/cordis-runtime.md` holds the chronological plan
> (§1–§23); this file is the state-of-the-world reference. Plugin service
> coverage: **`docs/dsh-plugin-compatibility.md`**. Pre-Cordis leftovers audit +
> cleanup plan: **`docs/pre-cordis-leftovers-audit.md`**. Approval-gating audit
> + fix plan: **`docs/approval-gating-audit.md`**.

---

## 1. System map

```
┌──────────────────────────── Renderer (Next.js static export) ─────────────────────────────┐
│  Chat UI · Coding UI · Insights · Settings                                                 │
│  store/slices/{chat,board,notes,...} (Zustand)          useChatStream.ts (live streaming)   │
│        │                                                       │                            │
│        └─ ipc() / ipcAwait() ────────────────┬───────────────┘ (preload electron.*)        │
└───────────────────────────────────────────────┼────────────────────────────────────────────┘
                                                │  Electron IPC (contextIsolated)
┌───────────────────────────────────────────────▼────────────────────────────────────────────┐
│  Electron main                                                                              │
│                                                                                             │
│  runCordisLoop / runCordisCodingLoop   ── one Cordis Context (singleton `sharedCtx`)        │
│        │                                                                                    │
│        │  buildCordisUserContent → db (better-sqlite3, MCP/tool data only)                  │
│        │                                                                                    │
│  ════════════ Cordis Context (sharedCtx) ════════════                                       │
│  Loader (cordis-plugin-loader) mounts ENTRY_LIST declaratively:                             │
│    session · llm · system-prompt · agent · tools · user-questions · approval ·             │
│    session-persistence · agent-loop · attachment-store · token-meter ·                     │
│    compaction · llm-retry · subagent · skills · subagent-spawn · tool-subagent             │
│                                                                                             │
│  ctx.services: tools · skills · fs · sessions · agents · approval · userQuestions · cairn   │
│  ctx.cairn = { defineTool }        (stable plugin API surface)                              │
│                                                                                             │
│  ┌─ dsh agent-loop ─▶ dsh-llm-pi-ai adapter ─▶ provider bridge (responses | completions)    │
│  └─ dsh session-persistence-jsonl ─▶ <userData>/sessions/**/session.jsonl[.zstd]  (THRUTH)  │
│                                                                                             │
│  Plugin runtime (CAIRN_PLUGINS_DEV=1):                                                     │
│    plugin-loader.ts  reads <userData>/plugins/plugins.yml → mounts on LIVE ctx              │
│    plugin-installer.ts fetches github:/ → installed/<id>/ + symlinks app deps               │
│    ui-plugin-handlers.ts  serves `ui:` sources to the renderer                              │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Session-as-truth.** Chat + coding transcripts live ONLY in dsh's JSONL session
log (`.jsonl.zstd` via zstd, under `<userData>/sessions/`). SQLite `chat_messages`
/ `pi_agent_messages` are legacy: never written, purged on launch. Replay reads
the session log (`electron/ipc/chat-session.ts`, `session-replay.ts`).

---

## 2. Composition model (getContext)

`electron/cordis/run-cordis-loop.ts:getContext()` builds the tree ONCE and
caches it in module-level `sharedCtx`.

- **Loader mount**: esbuild bundles main.ts to CJS and cannot see runtime
  `import("<string>")`, so NO plugin is `import()`ed by name. All plugins are
  statically imported and registered as `cordis:` builtins in a module map `B`:
  `B["dsh:tools"] = toolsPlugin`, `B["cairn:attachment-store"] = CairnAttachmentStore`,
  etc.
- **ENTRY_LIST** is a plain JS array `{ id, name: "cordis:…", config? }` — NO
  YAML, NO `!!js`. Row order carries no load semantics: activation is
  **inject-gating** (an entry starts when the services it injects are available),
  not row order.
- `ctx.loader.create(entry)` in a loop, then `ctx.loader.await()` settles.
- After settle, Cairn registers its **own** surfaced things onto the shared ctx:
  `ctx.cairn = { defineTool }`, the **cairn SKILL.md provider** on
  `ctx.skills`, and lazy `ctx.fs` chain.

### Builtins → service keys

| Entry id | `cordis:` builtin | provides |
|---|---|---|
| session | `cordis:dsh:session` | `sessions` registry |
| llm | `cordis:dsh:llm` | LLM seam |
| system-prompt | `cordis:dsh:system-prompt` (persona suppressed) | systemText |
| agent | `cordis:dsh:agent` | `agents` (resume/create) |
| tools | `cordis:dsh:tools` (mode:native) | `tools` (register/get) |
| user-questions | `cordis:dsh:user-questions` | `userQuestions` |
| approval | `cordis:dsh:approval` | `approval` |
| session-persistence | `cordis:dsh:session-persistence` | `sessionPersistence` |
| agent-loop | `cordis:dsh:agent-loop` | `agentLoop` |
| attachment-store | `cordis:cairn:attachment-store` | `attachments` |
| token-meter / compaction / llm-retry | dsh builtins | pressure + auto-compact + retry |
| subagent (+spawn +tool-subagent) | dsh/cairn | subagent capability |
| skills | `cordis:dsh:skills` | `skills` registry |
| invariants | `cordis:dsh:invariants` | `invariants` registry (companion plugins) |

---

## 3. Chat loop data flow

`runCordisLoop(opts)` (used by chat + one-shot helpers):

1. `getContext()` → `ctx`.
2. **Plugin fs chain** (dev-gated): if plugins enabled and `ctx.get("fs")`
   absent → `mountFsChain({cwd})` (see §6). Runs artifact hygiene (`.chat`).
3. `resolveTransport` probes `/responses` vs `/chat/completions`, caches by
   base URL → `ensurePiAiAdapter({api})` sets the wire mode.
4. **Sees the live agent per thread** — `globalThis.__cairnChatAgents`
   keyed by `threadId`; reuse if live, else `agents.resume(stableId)` →
   fall back `agentLoop.createAgent` → "already exists" → resume again →
   "while it is live" → force-drop + retry once.
5. `buildCordisUserContent` folds text + image attachments (via the attachment
   store → `ImageBlock`/tool-results), PDFs degrade to a text note.
6. `agent.followup(createUserMessage(...))` — NO history replay; the stable
   SessionId (`chat-<threadId>`) already carries prior turns in the persisted
   log (the "bonkers duplicate" fix).
7. **Session listener** (`ctx.on("session/event")`) single-sources chips:
   - `tool/call` → pending chip (all tools incl. plugins),
   - `tool/result` → done chip + `meta` (reads `event.data.meta`, falls back to
     `resolvePresentationMeta`), Cairn's per-tool `emitDone` enriches with
     `cairnRef`/`externalRef`.
8. Streams: `chat:token`, `chat:thought` (reasoning deltas), `chat:usage`,
   `chat:done` (content + reasoning + reasoningItems).

---

## 4. Tool bridge

- Cairn tools: `registerCairnTools(ctx, ...)` wraps each `defineTool` with its
  real schema and existing `executeTool` → `ctx.tools.register`.
- External/MCP/custom services: `registerExternalCairnTools` → `ctx.tools`.
- Plugin tools: a plugin backend reads `ctx.cairn.defineTool` (its `apply(ctx)`)
  and registers on `ctx.tools`.
- **Tool definitions are captured lazily** via `ctx.tools.get(name)` (+ cache in
  `toolDefsByName`) so `output.presentationMeta(args, value)` can be recomputed
  at render time — dsh does **not** persist presentationMeta (see §7.1).

---

## 5. Replay (session-as-truth)

`electron/ipc/chat-session.ts` + `session-replay.ts`:

- `db:chat:sessionMessages(threadId)` → `getContext()` → `pers.inspect(stableId)`
  → `deriveMessagesFromEvents(foldSurface(events))` → `collapseDerivedToMessages`
  (buffer reasoning + tool-results onto the next assistant text, attach sub-agents).
- **`prepareReplayContext`** is called first: dev-gated, mounts the fs chain
  (cwd from the session header) + `settleLoader` so plugin toolviews are
  registered before `tools.get(name)` enrichment.
- `toChatMessages` maps `status:"done"` onto tool calls; `enrichToolCallsWithMeta`
  attaches `meta`.

---

## 6. Service ownership & the fs trio

`sandbox` / `sandboxPolicy` / `fs` are a **per-context ownership trio** — the
names can be registered exactly once per context lifetime.

- `SandboxedFileSystem extends LocalFileSystem`, `static inject = ["sandboxPolicy"]`,
  registers `"fs"`. Coding mounts the whole trio per-turn
  (`cordis-coding-tools.ts:mountCodingStack` → `plugFsChain`), disposed at turn
  end.
- Chat mounts the trio lazily (`mountFsChain`) only when plugins are dev-enabled
  and `fs` is absent, and KEEPS it (never disposed). Later coding turns **ADOPT**
  the existing services instead of re-registering (`plugFsChain` catches
  `service "…" has been registered`).
-   Tradeoff: whichever side mounts first owns sandbox root/mode for the process;
  plan mode is dsh-owned advisory state (plan:policy section + exit_plan_mode
  via `planMode.set(agent)`), with no custom read-only tool guard.
- **`.chat` artifacts**: the chat fs chain `remapChatArtifactDirs` rewrites the
  plugin-artifact prefix `viz(/…)` → `.chat/viz(…)` on `fs.resolve`. Hygiene
  (`artifact-hygiene.ts`) migrates legacy `viz/`, lists `.chat/`+`viz/` in
  `.git/info/exclude`, and caps `.chat/viz` at 100 files.

---

## 7. What dsh does NOT do for us (and where we bridge)

1. **presentationMeta is not persisted.** Tool result events carry it at
   `event.data.meta` only when the harness materialised it; replay recomputes
   from the registered def, or reads persisted `data.meta`. Community toolviews
   (e.g. dsh-visualize's `VisualizeCard`) read `block.meta` — we wire it through
   `contract.ToolResultNode.meta` → adapter → `KeyedSlotOutlet`.
2. **Theme/palette is host-injected.** The card iframe reads `var(--dsh-viz-*,
   <fallback>)` with a documented "outside DSH the fallbacks apply" — sandboxed
   iframes can't inherit our CSS vars, so community cards use OS-adaptive
   `light-dark()` fallbacks. Vendored dsh components (SkillRow) use the
   `dsw-theme.css` scoped shim because they live in OUR DOM.
3. **Plugin code-resolution.** User plugins sit outside the app's node_modules;
   `plugin-installer.ts` symlinks the app's copies of declared deps into
   `installed/<id>/node_modules`. Backends that import `@deepseek-ai/*` by bare
   name resolve through those symlinks. Type-only `dsh-client-*` imports are
   erased at build; the renderer platform-module table provides
   `react`/`react/jsx-runtime`/`react-dom`.

---

## 8. Keeping the stack up to date

We deliberately track dsh closely: bump, then fix our fixtures/tests to match.
This is the repeatable loop.

### Bump checklist
1. Find the target line: `npm view @deepseek-ai/<pkg> dist-tags --json` (we use
   the `next` tag; `latest` is often a placeholder `0.0.1-rc.1`).
2. Update all 39 `@deepseek-ai/dsh-*` deps in `package.json`
   (e.g. `^0.1.0-rc.8` → `^0.1.1-rc.2`) + add any package dsh-visualize-type
   plugins now need (`dsh-skill` case). Never touch the project version
   (release scripts own it).
3. **Pre-req**: peer-dep resolution deadlocks on a partial tree. Clear the
   stale lock entries first, then reinstall:
   `rm -rf node_modules/@deepseek-ai/dsh-*`, strip `@deepseek-ai/dsh-*` keys
   from `package-lock.json` in a script, then `npm install`.
4. Verify graph: single `cordis` copy (`find node_modules -path '*cordis/package.json' | wc -l`),
   no `0.1.0-rc.8` stragglers.
5. `npm run compile` + `npm run type-check:all` (fix API breaks in our code).
6. Live sweep `CORDIS_LIVE=1 CORDIS_DUMMY_KEY=local npx vitest run electron/cordis/*.live.test.ts`
   (model bridge at `http://localhost:3042/v1`, `claude-sonnet-4-5`).
7. Update fixtures whose assertions encode retired behavior (see §8.1), changelog
   (`v2.7.x`), docs §.

### 8.1 Known historical breakage points (each bump, check these)
| Symbol | Symptom if stale | Fix |
|---|---|---|
| `AttachmentStore.readImageRequest(ref, policy, signal)` | "cannot derive model-request images" | implement on `CairnAttachmentStore` (bytes passthrough + deterministic `variantId`, `depth/space/hasAlpha`) |
| session jsonl compression/naming | replay empty or "not found" | `session.jsonl[.zstd]`, `<root>/<encodedCwd>/<id>/…` plaintext+flat fallbacks are handled in handlers |
| `SessionId` stringification | replay path lookups fail | usually still a branded string — verify `String(SessionId(x))` |
| agent disposal | `cannot prepare session … while it is live` after clear | dispose via `Symbol.asyncDispose`/`Symbol.dispose` (not plain `.dispose`) |
| tool `presentationMeta`/`meta` location | community toolview shows text not card | read `event.data.meta`, fall back to `resolvePresentationMeta` |
| skill provider validators | "returned skill … with a non-string provider" | candidates/definitions must carry `provider === providerName`, `source`, `rank` |
| `inject` gating | plugin backend never activates | ensure required services exist (`skills`, `fs`) before enrichment |

### Fixtures that encode behavior (update together)
- `electron/cordis/pi.live.test.ts` — JSONL persistence (not `chat_messages`),
  context-via-session (not `req.history`), 120s timeouts.
- `electron/cordis/coding-agent.live.test.ts` — `makeDb()` uses `applySchema`
  (`tool_attachments`); HITL is a known model-choice flake (passes solo).
- `electron/cordis/cairn-attachment-store.test.ts` — `readImageRequest`.
- `electron/cordis/cairn-skill-provider.test.ts` — provider shape + real registry.
- `electron/cordis/presentation-meta.test.ts`, `drop-chat-agent.test.ts`,
  `viz-remap.test.ts`, `artifact-hygiene.test.ts`.

---

## 9. Open / possibly-missed (post-refactor inventory)

1. **Tier-3 untrusted-code sandbox** — plugins run with full main-process
   privileges today (`CAIRN_PLUGINS_DEV=1`). `plugins:install` is dev-gated and
   must warn "trusted sources only" until a `node:vm`/worker sandbox exists
   (plan §10.8). Highest priority before releasing the install flow.
2. **Backend capability parity (`ctx.cairn`)** — dsh-visualize's tool executes
   great; richer community backends need `ctx.get("sandboxPolicy")` resolution
   and dsh `fs`/`skill`/`sandbox` shims for the inject-gated seams.
3. **Upstream proposals** (both would remove Cairn-side shims):
   - `dsh-visualize`: configurable artifacts dir (`Config.artifactsDir`) instead
     of hardcoded `viz/` — lets hosts point it at `.chat` natively.
   - toolview cards: accept an optional `palette`/inherit host CSS vars so hosts
     can theme them (we fall back to `light-dark()` today).
4. **Replay edge**: a raw probe once surfaced `session "chat-…" not found` from
   the persistence coordinator outside a full app boot; the handler swallows
   "not found/ENOENT". Worth a hermetic regression test against a fixture log.
5. **Dead threads**: threads with neither jsonl nor SQLite remain listed forever
   (pre-cutover purge). Consider hiding/removing them.
6. **Cairn-styled secondary viz view**: if Cairn-exact theming is wanted for
   community cards, register a thin Cairn-native `visualize` view with a lower
   priority than the community entry (community stays canonical).

---

## 10. Where things live (file map)

| Concern | Files |
|---|---|
| Runtime bootstrap + ENTRY_LIST + shared ctx | `electron/cordis/run-cordis-loop.ts` |
| Coding loop + fs/sandbox stack | `electron/cordis/run-cordis-coding.ts`, `cordis-coding-tools.ts` |
| Replay / session-as-truth | `electron/ipc/chat-session.ts`, `pi-session-handlers.ts`, `cordis/session-replay.ts` |
| Tools bridge | `electron/cordis/cairn-tools.ts` |
| Plugin runtime (backend) | `electron/cordis/plugin-loader.ts`, `plugin-installer.ts` |
| Plugin IPC + service | `electron/ipc/ui-plugin-handlers.ts`, `electron/preload.ts` |
| Plugin UI (renderer) | `src/lib/plugin-ui/{loader,platform-modules,dsh-client-ctx,dsh-slot-map,slot-matrix,registry}.ts`, `SlotOutlet.tsx` |
| Toolview dispatch | `src/lib/dsh-toolview/{contract,adapter}.ts`, `ToolCallIndicator.tsx`, `ChatMessageBubble.tsx` |
| Attachment store | `electron/cordis/cairn-attachment-store.ts` |
| Skill bridge | `electron/cordis/cairn-skill-provider.ts`, `src/lib/plugin-ui/` |
| Artifacts hygiene | `electron/lib/artifact-hygiene.ts`, `codebase-index.ts` |
| Plan history | `docs/plans/cordis-runtime.md` (§1–§23) |
