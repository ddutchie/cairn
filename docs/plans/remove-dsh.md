# Plan: Remove Cordis/dsh (`@deepseek-ai/*`) from Cairn

> Branch: `refactor/remove-dsh` · Opened 2026-10-30 · Status: **draft**

Trigger: a reported US restriction on DeepSeek products. Cairn v3 moved the
whole agent runtime onto the DeepSeek harness (Cordis + `dsh-*`). This plan
replaces it with a smaller Cairn-owned engine on `pi-ai`, keeps every current
feature, and carries all existing JSONL history across.

---

## 0. Decisions

| # | Decision | Status |
|---|---|---|
| 1 | What exactly is restricted (API/models only, or any DeepSeek-published software incl. MIT npm packages)? Decides how urgent Phase 1 is. | **Open** |
| 2 | Engine: a new Cairn-owned loop on `@earendil-works/pi-ai` | **Decided** |
| 3 | One loop for chat + coding (+ automations, subagents); surfaces become *profiles* that pick tools, prompt and policy | **Decided** |
| 4 | Feature scope: **all current features are kept** (§5) | **Decided** |
| 5 | JSONL history: all existing sessions must be imported and replay identically (§3) | **Decided** |
| 6 | Keep DeepSeek as a selectable model provider for users outside the US? (`usage-recorder.ts`, pricing, picker colours) | **Open** |
| 7 | User plugin system (loader, installer, renderer slots, Settings → Plugins): never launched → **removed** on this branch (§4 Phase 0b) | **Done** |

---

## 1. Current footprint (measured)

| What | Size |
|---|---|
| Direct deps in `package.json` | 100 `@deepseek-ai/*` + `dsh-context-ring` (github fork) |
| Installed under `node_modules/@deepseek-ai` | 144 packages, 46 MB |
| `electron/cordis/` | ~20.5k lines (incl. tests), 15 internal Cordis plugins (engine modules, not user plugins) |
| Non-test importers outside `electron/cordis/` | 5: `electron/subprocess-runner.ts`, `electron/ipc/{session-runtime-handlers,chat-session,session-run}.ts`, `src/components/agent/ContextRing.tsx` |
| Patches | `patches/@deepseek-ai+dsh-llm-pi-ai…`, `…dsh-session-format-v3-to-v4…` |
| Most-imported packages | `cordis` (61), `dsh-session` (35), `dsh-llm` (14), `dsh-system-prompt` (10), `dsh-tools` (9), `dsh-agent` (9) |

Findings:

- **No runtime calls to DeepSeek.** The packages are MIT and contain no
  `deepseek.com` endpoints. Transports (`electron/lib/llm.ts`, `responses.ts`,
  `sse.ts`) are ours and `pi-ai` is not a DeepSeek package. The only
  `api.deepseek.com` strings are our provider preset/usage labels.
- **Seams already exist.** App I/O is behind `HostStore`
  (`electron/cordis/host-store.ts`). IPC enters via `run-cordis-loop.ts` /
  `run-cordis-coding.ts`. The renderer touches dsh in one component.
- **Chat and coding are already ~90% the same loop, written twice.**
  `chat-session-runner.ts` (520 lines) and `run-cordis-coding.ts` (504) both
  sit on `runCordisSession` (`session-runner.ts`, which already has a
  `CordisSessionProfile` concept) and both re-mount approvals, doom-loop,
  questions, MCP, usage and event forwarding; comments in each point at the
  other ("same as coding", "see run-cordis-coding.ts"). The real differences
  are: tool set, system prompt, approval policy, fs mount, and whether the
  agent is kept warm between turns.
- **`tool-inventory.ts` already models per-surface tool sets**
  (chat / coding / automation-dev / MCP) for the Settings UI — but only as a
  *description* computed alongside the real registration. It should become
  the thing that drives registration.

---

## 2. Target architecture: one engine, many profiles

```
IPC (channels unchanged)
  └─ runAgentTurn(sessionId, profile, input, sinks)
        │
        ├─ Profile  (data, not code paths)
        │    id: chat | coding | automation | automation-dev | subagent | heartbeat
        │    tools:      ToolSet       ← from tool-inventory (single source)
        │    prompt:     (ctx) => string   buildSystemPrompt / coding-session-prompt
        │    approval:   policy (chat: gate deletes + external; coding: presets)
        │    workspace:  none | fs(cwd)    (mounts fs/bash/search/LSP/terminal)
        │    retain:     keep agent warm between turns?
        │    usage:      usage source for accounting
        │
        ├─ loop.ts       pi-ai stream → tool calls → approvals → exec → repeat
        │                abort, retry/backoff, token meter, doom-loop guard
        ├─ middleware    ordered hooks around model/tool calls:
        │                approval · questions · compaction · spill · pruning ·
        │                context ring · usage · title · hooks(CC/Codex) · goal driver
        ├─ session/      append-only event log (cairn-session/v1), replay,
        │                fork, projections (todos, plan, stats, ring)
        └─ HostStore     moved unchanged
```

Why this is simpler than today:

- **One loop, one test suite.** Chat-vs-coding becomes a profile table, so a
  fix to approvals/compaction/retry lands once. Switching a thread from chat
  to coding is just a profile change on the same session.
- **No DI container.** Cordis `ctx.services` / `ctx.plugin` / loader settling
  (incl. the "loader entry would stall `loader.await()`" class of bugs) is
  replaced by plain imports + an explicit middleware list.
- **Tools declared once.** `TOOL_SCHEMAS` + coding tools + MCP + skills feed
  one `ToolRegistry`; a profile is a filter over it. Settings → AI shows the
  same object the engine runs.
- **Subagents are just nested `runAgentTurn` calls** with the `subagent`
  profile and a parent session link — no separate spawn package.

Sketch:

```ts
export interface AgentProfile {
  id: ProfileId;
  tools(reg: ToolRegistry, ctx: TurnContext): Tool[];
  systemPrompt(ctx: TurnContext): Promise<string>;
  approval: ApprovalPolicy;
  workspace: { kind: "none" } | { kind: "fs"; cwd: string };
  retainAgent: boolean;
  usageSource: UsageSource;
  middleware?: Middleware[];   // profile-specific extras (e.g. goal driver)
}
```

---

## 3. JSONL history: import, don't lose a byte

Facts:

- Since migration v49 the dsh JSONL log is the **only** transcript
  (`<userData>/sessions/**/session.jsonl[.zstd]`, also `session.v4.jsonl.zstd`).
- Files carry a format version; dsh migrates v0 → v1 → v2 → v3 → v4 via
  `dsh-session-format-v*-to-v*` (~6.4k lines total, MIT, already patched by us
  for a pruner quirk).
- Event types seen in a dev profile: `session`, `turn/start|end`,
  `step/start|end`, `user/message`, `assistant/chunk|message`,
  `text-chunks`, `reasoning-chunks`, `tool/call|result`,
  `agent/inbox/spliced`, `request/header|context`, `session/title`,
  `session/end-seed`, `compaction/prune`, `approval/policy`,
  `permission/preset`, `sandbox/mode`. Real user profiles will have more
  (subagents, goals, plan, jobs) — the full union must come from the
  format catalog, not from samples.

Approach:

1. **New format `cairn-session/v1`** — deliberately close to dsh v4's
   event model (turn → step → message/tool events, monotonic `seq`,
   `surfaceOp`), because that model is sound and closeness makes import
   near-lossless. We document and own the schema
   (`shared/agent/session-format.ts`, zod), and drop the parts we don't need
   (chunk-level events are coalesced at turn end).
2. **Frozen importer** `electron/agent/session-import/`:
   vendored, read-only copies of the dsh format migrators (MIT, attribution
   kept) → bring any file to v4 → map v4 events to `cairn-session/v1`.
   It is the *only* place dsh-derived code survives, it never runs on the
   hot path, and it can be deleted once telemetry shows no unimported files.
3. **When it runs:** once at first boot of the new engine, in the background,
   per file; plus lazily on open if a file was missed. Idempotent via a
   marker (`session.cairn.jsonl` beside the original + an index row).
4. **Originals are never modified.** Move to
   `<userData>/sessions-dsh-archive/` only after a successful import +
   verification; keep for at least two releases.
5. **Verification:** for every imported session, render the transcript via
   the old replay (`session-replay.ts` on the dsh engine) and the new one and
   diff. Ship the importer with a golden corpus: real (anonymised) sessions
   covering every format version, every event type in the catalog, zstd +
   plain, pruned/compacted, forked, subagent children, and the pruner-quirk
   case our patch exists for.
6. **Mobile/sync:** check `mobile/` and `shared/` for anything that reads
   session files or `session-wire` and move it to the new types.

---

## 4. Phases

### Phase 0 — Freeze (½ day)
- [ ] CI check: fail on new `@deepseek-ai/*` / `dsh-*` dependencies.
- [ ] `npm pack` the 144 installed packages into private storage so builds
      survive an npm unpublish or scope takedown.

### Phase 0b — Drop user plugins (done)
- [x] Removed `plugin-loader`, `plugin-installer`, `plugins-template/`,
      `ui-plugin-handlers`, `plugins:*` IPC/preload/contract, `src/lib/plugin-ui/`
      (slot outlets), Settings → Plugins, and `ctx.cairn.defineTool`.
- Kept deliberately: `ctx.cairn.confirm` + `approval-transports.ts` (the
  doom-loop guard asks through it — fold into the approval middleware in Phase 3).
- Follow-ups for the new engine: the `viz/` artifact remap
  (`cordis-coding-tools.ts`) and matching hygiene (`artifact-hygiene.ts`) only
  served community plugins (dsh-visualize) and can be dropped once nobody
  has leftover `viz/` output to clean; `src/lib/dsh-toolview` still hosts the
  built-in `skill` view and can be simplified.
- Plugin docs removed: `dsh-plugin-compatibility.md`, `building-a-dsh-plugin.md`.

### Phase 1 — Vendor & de-brand (1–2 days) — *stopgap, can ship alone*
- [ ] Copy used packages into `vendor/harness/` as workspace packages under
      `@cairn/harness-*` (keep LICENSE/attribution); fold in both patches.
- [ ] Rewrite imports, drop the 101 deps, regenerate `licenses.json`.
- [ ] Remove `deepseek-harness/*` user-agents (`cordis-context.ts:343`,
      `cairn-identity.ts`, `session-runtime.ts`).
- Exit: zero `@deepseek-ai` deps, identical behaviour.

### Phase 2 — Session format + importer (1 week)
- [ ] `cairn-session/v1` schema + writer + reader + projections
      (todos, plan, stats, title, context ring).
- [ ] Frozen importer (§3) + golden corpus + replay-diff harness.
- [ ] Point `session-replay`, `session-export`, `session-inspect`,
      `session-stats`, session query/search at the new reader (reading
      imported files) while dsh still writes.
- Exit: every session in a real profile imports and replays identically.

### Phase 3 — Unified engine, chat profile first (1–2 weeks)
> Design: `docs/plans/agent-engine-design.md` (rules-as-data permissions,
> policy pipeline, auto-mode reviewer).
- [ ] `electron/agent/loop.ts` on pi-ai (stream, tool calls, parallel exec,
      abort, retry/backoff, token meter, doom-loop).
- [ ] `ToolRegistry` built from `TOOL_SCHEMAS` + `tool-inventory.ts`;
      inventory becomes the registration source.
- [ ] Middleware: approvals + grants (port `approval-runtime`,
      `approval-grants`, `permissions-bridge`), user questions, usage.
- [ ] `chat` profile; setting `agentEngine: "cordis" | "cairn"` (dev-only).
- Exit: chat parity on live test models; writes `cairn-session/v1`.

### Phase 4 — Coding + automation profiles (1–2 weeks)
- [ ] `workspace: fs` mount: read/write/str-replace/search, bash +
      subprocess, secrets scrubbing, web fetch.
- [ ] `coding`, `automation`, `automation-dev`, `heartbeat` profiles —
      each a profile table entry, no new loop code.
- [ ] Compaction (basic + tool-result pruner + image offload), spill,
      `compaction-budget`, `context-usage`, `ContextRing.tsx`.
- Exit: every coding `*.live.test.ts` passes on the new engine.

### Phase 5 — Remaining features (2 weeks)
- [ ] Subagents (nested turns, continuable, control/list).
- [ ] Plan mode, todos, session title (first-prompt LLM), slash commands
      (`/compact`, `/goal`), skills (filesystem).
- [ ] MCP client + resources on `@modelcontextprotocol/sdk`.
- [ ] Jobs, goals + round driver, schedule, LSP, terminal,
      workflow/PTC + ralph, hooks (Claude Code / Codex compat),
      pwsh + sandbox, session-query tools.
- Exit: full feature checklist (§5) green; all `electron/cordis/` tests
      have a counterpart in `electron/agent/`.

### Phase 6 — Cutover & cleanup (1 week)
- [ ] Default `agentEngine: "cairn"`; run the importer at boot; keep
      `cordis` fallback for one release.
- [ ] Next release: delete `electron/cordis/`, `vendor/harness/`, patches,
      `docs/dsh-*.md`; rewrite `architecture-cordis.md` as
      `architecture-agent.md`; update `AGENTS.md`.
- [ ] Changelog + What's New entry.
- [ ] Later: delete `session-import/` once no dsh-format files remain.

**Rough total: 6–9 weeks** after Phase 1. Phase 1 alone removes the
dependency on DeepSeek's npm scope within days.

---

## 5. Feature checklist (all kept) — where each lands

| Today (dsh) | New home |
|---|---|
| agent, agent-loop, llm, llm-pi-ai, llm-retry, token-meter | `loop.ts` |
| session, persistence-jsonl, projection, stats, title, log-export, query(-sqlite) | `session/` |
| tools, tool-fs, fs-search, str-replace-editor, bash, subprocess, shell(-env), fs-observation-policy | tools + `workspace: fs` |
| sandbox(-local, -policy), fs-sandbox, bash-sandbox, pwsh(-local, -sandbox), tool-pwsh | tools + sandbox middleware |
| user-approval, permission-presets, user-questions | middleware (logic already Cairn's) |
| compaction (basic, image-offload, tool-result-pruner), spill(-local, -policy), command-compact | compaction middleware |
| subagent, spawn-in-process, tool-subagent(-control) | nested `runAgentTurn` |
| skill, skill-filesystem, tool-skill, commands, plan-mode, tool-todo | middleware + tools |
| mcp-client, mcp-resources | `@modelcontextprotocol/sdk` |
| goal, goal-round-driver, tool-goal, command-goal | goal middleware |
| jobs(-local), tool-jobs, schedule | jobs service |
| lsp(-stdio), tool-lsp, terminal, tool-terminal | workspace services |
| web, web-fetch-http, tool-web | tools |
| workflow, workflow-ptc, ptc-runtime(-node), tool-workflow, tool-ralph | workflow service |
| hook-protocol, hooks-claude-code, hooks-codex | hooks middleware |
| attachment | session attachments |
| storage(-json, -domain), settings, home-paths, scope, invariants, brand, system-prompt, agent-instructions, agent-default-model | absorbed into HostStore / profile / settings |
| `dsh-context-ring` (our fork) | context-ring projection |

---

## 6. Risks

- **History loss** — mitigated by §3: import, verify by diff, never touch
  originals, archive for two releases.
- **Behaviour drift** in the unified loop (compaction thresholds, retry,
  truncation, approval edge cases) — port tests with the code; run live
  tests on both engines through Phases 3–5.
- **Profile leakage** — a chat turn must never see fs/bash. Test that each
  profile's registered tools equal its inventory entry exactly.
- **Restriction scope (§0.1)** — if it turns out not to cover MIT packages,
  Phase 1 is a valid pause point; the unified engine is still worth doing
  for simplicity, on our own schedule.
