# dsh `0.1.2-rc.1` Evaluation — Upgrade Plan for Cairn v3.0.x

> **Status:** landed on `ddutchie/dsh_012` at `0.1.2-rc.1` — compile + `type-check:all` + full Electron suite green, **live sweep done** (see §5.1). **Continuable-subagent full slice implemented** (see §9); PR-2 (Schedule opt-in) not started.  
> **Date:** 2026-09-03 · **Cairn pinned (this branch):** `0.1.2-rc.1` + `cordis@4.0.2` · **main:** `0.1.1-rc.2` + `cordis@4.0.1`  
> **Upstream publishes:** every `@deepseek-ai/dsh-*` at `0.1.2-rc.1` is `npm publish`ed (tarball verified) **except** `dsh-tool-subagent-report`, which stops at `alpha.3` — removed upstream in `alpha.4` (see §1.6). `alpha.1` was tag-only, never published.  
> **Generic bump playbook:** [`docs/dsh-upgrade-guide.md`](../dsh-upgrade-guide.md)

---

## TL;DR

* **Scope:** 1079 commits vs `rc.2` (master `cd5ef8148`), 241 dsh-family packages (+9 vendor). The diff is not a patch — it's an **alpha train** with architecture-level changes.
* **For Cairn, the win is real:** durable `schedule` reminders ("remind me in 10 min…"), subagent model routing (`provider/model/reasoning_effort` + `list_subagent_models`), image-capable subagent followups, a real tool-call scheduler, and a `sessionQuery` projection cache that makes cold subagent listing fast.
* **Target `alpha.5`, not `alpha.3`.** `alpha.4` (Sep 1, `4e84901`) carries the breaking changes — bidirectional `send_message` replacing the one-way `report` tool, `Session.events` → `seq`/`eventAt()`/`snapshotEvents()`, `SessionSeq`/`SessionLogOffset` branding, `seedLength` → `isSeeded` + `inheritedEventCount`. `alpha.5` (Sep 2, `db6bdc3`) is a **single-bugfix republish** (upgrade from `rc.2`/`alpha.3` could prevent app start or lose session titles) with **byte-identical `lib/`** to `alpha.4` across all 16 packages checked — version + peer bumps only. Targeting `alpha.5` gets the fix for free.
* **`0.1.2-rc.1` (Sep 3, `a66e470`) is the same story one step further.** `next` tag now points at it — the promotion this plan was waiting for. `lib/` **byte-identical `alpha.5 → rc.1`** across all 20 packages checked — version + peer bumps only. The release notes are a rollup of the alpha train (no new library surface; Inspector/Web Preview are app-bundled, not published packages). The branch tracks `0.1.2-rc.1` (see §1.8).
* **Risk is contained if adopted in two phases:** mechanical bump (no new mounts) is low-risk; capability enablement is opt-in. Mandatory migrations: descriptor `2→3`, `SessionId()` → `brandString()` on control paths, `SessionSeq()` wrapping where Cairn compares `event.seq`, and dropping `dsh-tool-subagent-report` from the dep list.
* **Recommendation (landed):** this shipped as PR-1 (mechanical bump, first to `alpha.5` then fast-followed to `rc.1` in ~30 min once `next` promoted) **plus** the continuable-subagent full slice (§9) — broader than the original two-PR sketch because the live sweep proved the messaging seam ready. Remaining: PR-2 (Schedule as an opt-in Setting) and deferred model-selected routes. Keep tracking `next` the same way for the next RC.
* **Why the user saw "schedule messages to subagents":** upstream's `dsh-schedule` **is** "schedule a message to yourself later" — a durable follow-up delivered as an ordinary message in **the same session**, not an inter-agent scheduler. The subagent improvement in this train is **model-selected routing**, **image forwarding**, and (new in `alpha.4`) **bidirectional `send_message`**, not scheduled delivery. `dsh-schedule` and `ctx.subagents` are orthogonal seams.

---

## 1  What shipped in `0.1.2-alpha.3` (vs our `0.1.1-rc.2`)

### 1.1  Cordis 4.0.1 → 4.0.2 (minor, must move together)

* `@deepseek-ai/cosmokit 1.8.2→1.8.3`, `@deepseek-ai/cordis-plugin-loader 1.0.2→1.0.3`, `@deepseek-ai/cordis-plugin-include 1.0.6→1.0.7` — no Cairn behavioral change; `loader.builtins` shape unchanged.

### 1.2  `dsh-schedule` — the headline "schedule a message" feature

* **Package:** `@deepseek-ai/dsh-schedule@0.1.2-alpha.3` (npm tag `alpha`). Previously at `rc.2` with the same tool names but a much thinner projection layer.
* **Tools:** `schedule_create` / `schedule_list` / `schedule_delete` via `ctx.schedule` (agent-scoped, root agents only). Selectors: `after_seconds` (delay), `at` (RFC3339 `Z`/offset **or** `{date, time, time_zone:IANA}`), `every_seconds` (≥5 min, anchor-aligned). Every create stores canonical UTC `scheduledAt`; dispatch appends `acceptedAt` and advances `every` directly to the next anchor target (no backlog replay — latest-only).
* **Durability:** `schedule/change` version-1 events (create/delete/dispatch) own state; timers + follow-ups are disposable projections. Every read/decision awaits `ctx.sessions.flush(session)`; an absent persistence returns `persistence_uncertain`, not a false answer.
* **Delivery:** due one-shots have priority, then batched `every`s in target+creation order; enters one later turn via `Agent.followup()` **after** idle maintenance is claimed (`runMaintenance()`). Never steers/interrupts the current turn; dispatch means queued+recorded, not "model succeeded".
* **Projection (new in alpha.3, re-keyed in alpha.4):** optional `schedule` projection unit sharing `applyScheduleChanges` with full replay. Enables read-only active-reminder catalog (and the Web's alarm-dot) without scanning the log. Forks exclude parent reminders (`events.slice(seedLength)` in `alpha.3`; `inheritedEventCount`/`ownEvents()` in `alpha.4+` — see §1.6).
* **Client export (new):** `@deepseek-ai/dsh-schedule/client` — browser-safe `ScheduleRecord[]` type only.
* **Operational notes:** load the overlay before the session (`dsh web --patch apps/cli/config/examples/schedule/cordis.yml`). Sessions created before the overlay have no reminder tools. Cold sessions queue overdue work until a future live root agent resumes — no external email/SMS/push.

**For Cairn:** we load no `dsh-schedule` plugin today, so current Cairn sees **zero regression** after the mechanical bump. The question is whether Cairn should adopt it. See §3.1.

### 1.3  Subagent family — biggest functional change

| Change | Detail | Cairn effect |
|---|---|---|
| **Model-selected routing** | `dsh-tool-subagent` now accepts optional `provider`/`model`/`reasoning_effort` per call; validates against a Host allowlist sampled per top-level Session (`subagentModelSelectionPolicy` projection, inherited). Adds `list_subagent_models` discovery tool. Preflight via `llm.resolveCallConfig` before child creation. | Opt-in via `modelSelectionSettings:true`. Without it, existing fixed-route path bit-identical. Cairn should **defer** — see §3.2. |
| **Descriptor v2→v3** | `SUBAGENT_DESCRIPTOR_VERSION 2→3`; v3 stores `agentReasoningEffort` alongside `agentProvider/agentModel`. | Cold resume reads v2 logs as `undefined` (no-op); new writes are v3. No migration needed. |
| **Parent route sourcing** | `parentAgentOptionsForDelegation()` now reads parent's **latest logged request** header before falling back to creation options; route change without explicit effort clears inherited effort so model default applies. | Child routing semantics change under the hood; no Cairn code change required unless we inspect `AgentOptions` directly (we don't). |
| **Image-capable followups** | `contentHasImage()` guard + `MODEL_DOES_NOT_SUPPORT_IMAGES` refusal before prompt enqueuing; text-only projection deferred to LLM layer when route not fixed. | Subagent messages can now carry images reliably (aligns with Schedule's "images in continuable subagents" fix). |
| **Session query** | Continuable cold-resume and `listChildren` now go through `@deepseek-ai/dsh-session-query` (`query.observeSession`, `query.listSessions`) instead of raw `persistence.inspect`. Requires the `sessionQuery` service (`dsh-session-query`). | Mounting `dsh-session-query` becomes mandatory for continuable children once bumped. If Cairn doesn't mount it, `sendMessage`/`interrupt`/`listAgents` will throw `CONTINUATION_UNAVAILABLE` / `SUBAGENT_CONTROL_QUERY_UNAVAILABLE`. Mechanical bump without the mount **breaks continuable subagents**. |
| **Typert** | `dsh-subagent` gains `typert.host` / `typert.remote-client` entries, `RemoteError`/`TypertRemoteService`, control validation via `zod`. | New deps `dsh-brand`, `dsh-util-values`, `dsh-util-time` pulled in transitively. |
| **Branded strings** | `SessionId(x)` string construction replaced by `brandString(x)` across subagent/control paths. | Cairn must migrate its own `SessionId(...)` calls (in `coding-agent.live.test.ts`, `session-runtime.ts`, etc.) — mechanical search/replace. |

### 1.4  Agent loop + session

* **Tool-call scheduler:** rolling bounded pool (`maxParallelToolCalls`), ordered commits, drain-on-failure, idle-latch wakeup — replaces the ad-hoc loop. No Cairn contract change, but live tool-call ordering fidelity improves.
* **`turnBoundary` projection:** `stateOf(session,"turnBoundary").lastTurn` replaces `session.events.findLast(e=>"turn/start").data.turn` — Cairn doesn't read this directly today, but is a signal that turn counting is now projection-backed.
* **`SessionId` / string branding:** harder typing (`Branded<'SessionId'>`) via `@deepseek-ai/dsh-brand`; helpers via `dsh-util-values` (`snapshotJsonValue`), `dsh-util-time` (`canonicalClientTimeZone`).
* **Session format:** `SESSION_FORMAT_VERSION` still `0` (no migration step). Per-session `projection_cache.json` + strict checkpoint schema for cold-read seeding.

### 1.5  Alpha.1 global refactor (inherited, not alpha.3-specific but ships now)

* `dsh-client-runtime → dsh-client-modules` (lazy CJS module table), `ApiProxy` package deleted (replaced by `Remote` controllers), `code-mode → PTC mode` rename, `CallId → ToolCallId`. Cairn doesn't use the client/module system directly today (we use our own Next.js renderer), so impact is documentation-only — but any community plugin author targeting the new Web shell must rebuild against the alpha train.

### 1.6  `alpha.4` (Sep 1, `4e84901`) — the breaking release in this train

Official notes ([releases](https://github.com/deepseek-ai/deepseek-harness/releases)): headline is **bidirectional `send_message`**; chores carry the session-model breakage. Verified by `alpha.3 → alpha.4` tarball diff:

* **Bidirectional messaging replaces `report` (by @Dudu-0223).** `ctx.subagents.followup(parent, childId, content, {source, signal})` → `sendMessage(sender, targetId, content, {signal})`. Delivery is now **Steer**: a running target admits at its nearest step boundary (not FIFO-next-turn); an idle target starts a turn; a missing child cold-resumes. Either direction works — a resident continuable child may target its direct parent. Durable attribution `coordinator` / `subagent-report` kinds → single `agent-message` kind; `SubagentFollowupOptions` / `SubagentReportOptions` / `reportFrom()` / `registerContinuableSetup()` **removed**. `dsh-tool-subagent-report` **not published** at `alpha.4`/`alpha.5` (stops at `alpha.3`) — the package is dead; drop it from Cairn's dep list at bump time (note: `src/generated/licenses.json` still references it — regenerates on `npm run test` via `generate-licenses.js`).
* **Model-visible `send_message` schema change.** Param `subagent_id` → `agent_id`; description now documents steering + parent-targeting. Docs wording in `dsh-tool-subagent` ("`send_message` starts a later turn") → ("steers the child's nearest step while running, starts a turn while idle"). `list_agents` copy updated to match. New `dsh-subagent/internal` export (`markAdjacentAgentSendMessageTool`, `queueSubagentPrompt`, `HostPromptQueue`) for host adapters.
* **`Session.events` → on-demand reads (by @kermanx).** `session.events` array replaced by `session.seq`, `session.eventAt(SessionSeq)`, `session.snapshotEvents()`, `session.ownEvents()`. `SessionEvent.seq: number` → branded `SessionSeq`; new `SessionLogOffset`, `SessionSeqCursor` (`SessionSeq | -1`), `OptionalSessionSeq` brands. Header `seedLength?: number` → `isSeeded: boolean` + `inheritedEventCount: SessionLogOffset` (exact fork prefix is now Session state, not header metadata). `dsh-schedule`'s fold signature follows (`foldScheduleEvents(events, inheritedEventCount)`; projection `{seedLength,…}` checkpoint → inherited-count based).
* **Cairn exposure (verified by grep):** Cairn **never** calls the removed APIs (`followup` on `ctx.subagents`, `reportFrom`, `registerContinuableSetup` — the only `followup` in our tree is the `Agent` inbox API, which is unchanged). Cairn has **zero** `seedLength` references. Cairn **does** compare `event.seq` numerically (`chat-session-runner.ts:42,396-407`, `cairn-plugins.ts:190`, tests) — runtime-safe (branded numbers are still numbers) but `tsc` will require `SessionSeq()` wrapping or type loosening at bump time.
* **Other chores:** `web_fetch` default-on for Python SDK / Headless / ACP / custom Profiles (by @koalazf99); Web PTC Mode no longer exposes the general `workflow` tool; `dsh-tool-subagent-control` drops its `./invariant` export; `dsh-session-query` drops `./invariant` and gains `inheritedEventCount` on `LogicalSession` / observations.

### 1.7  `alpha.5` (Sep 2, `db6bdc3`) — single bugfix, no code delta

Official notes: *"Fix an issue where upgrading from `0.1.1-rc.2` or `0.1.2-alpha.3` could prevent the app from starting or make session titles disappear from the list"* (by @imccyu). Verified: `lib/` **byte-identical `alpha.4 → alpha.5`** across all 16 packages checked (`dsh-agent`, `dsh-agent-loop`, `dsh-session`, `dsh-subagent`, `dsh-tool-subagent`, `dsh-tool-subagent-control`, `dsh-schedule`, `dsh-tools`, `dsh-llm`, `dsh-session-query`, `dsh-session-persistence-jsonl`, `dsh-system-prompt`, `dsh-commands`, `dsh-compaction-basic`, `dsh-subagent-spawn-in-process`, `dsh-agent-loop-testkit`) — version + peer-range bumps only. **Target `alpha.5` directly; there is no reason to land on `alpha.3`/`alpha.4` first.** The fixed bug (startup failure / lost session titles on upgrade) is exactly the failure mode a Cairn bump would otherwise risk reproducing.

### 1.8  `0.1.2-rc.1` (Sep 3, `a66e470`) — the RC promotion, no code delta

Official notes ([releases](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1)): *"first release candidate for v0.1.2 ... summarizes the major user- and developer-facing changes since v0.1.1-rc.2"* — a rollup of the alpha train, matching this document's §§1.1–1.7 line for line. Two nominally-new items (experimental Inspector, experimental Web Preview) are app-bundled, not published packages (`@deepseek-ai/dsh-inspector` / `dsh-web-preview` 404 on npm) — nothing for Cairn to adopt. `next` tag now resolves to `0.1.2-rc.1`; `cordis` stays `4.0.2`.

Verified: `lib/` **byte-identical `alpha.5 → rc.1`** across all 20 packages checked (the previous 16 plus `dsh-llm-pi-ai`, `dsh-user-approval`, `dsh-user-questions`, `dsh-plan-mode`) — version + peer-range bumps only. The `alpha.5 → rc.1` bump on this branch was therefore a pure `package.json` sed + lock reinstall: compile, `type-check:all`, and the 1201-test unit suite green with **zero code changes**, and the live sweep re-ran green (bridge `localhost:3042`, `claude-sonnet-4-5`; one model-flake retry on the questions test).

---

## 2  Impact on Cairn's mounted tree

### What Cairn mounts today (from `electron/cordis/cordis-context.ts`)

```
session, llm, system-prompt, agent, tools, user-questions, approval,
session-persistence (jsonl), session-query-sqlite, agent-loop, attachment-store,
spill, spill-policy, token-meter, tool-result-pruner, compaction, llm-retry,
subagent (+spawn), tool-subagent, tool-subagent-continuable, tool-subagent-control,
tool-subagent-list-agents, jobs-local, tool-jobs, skills, invariants, tool-skill,
commands, command-compact, plan-mode, session-title, session-title-first-prompt,
projection-registry
(+ per-turn coding stack: sandbox-local/policy, fs-sandbox, bash-sandbox, shell-env, tool-bash/fs/fs-search/str-replace/todo)
```

### What alpha.3 changes about that list

* **Mandatory new transitive peers** (bump-time, even if no new capability mounted): `zod ^4.4.3`, `@deepseek-ai/dsh-brand`, `@deepseek-ai/dsh-util-values`, `@deepseek-ai/dsh-util-time`. Already peer-required by `dsh-subagent`/`dsh-agent-loop` — must be present in `package-lock` or `npm install` fails to dedupe singletons.
* **Newly-required service for continuable subagents:** `@deepseek-ai/dsh-session-query-sqlite` (the backend — the abstract `dsh-session-query` is never mounted alone). Bump without adding it to the `B` map and `ENTRY_LIST` **regresses** continuable followups. Fix: add `B["dsh:session-query-sqlite"]` + the `session-query-sqlite` entry (node:sqlite only, no native binding; `:memory:` under vitest).
* **Optional mounts (deferrable):** `dsh-schedule` (+ `dsh-time-context` for natural-language zone inference), `model-selection-settings` service (only if we enable subagent model choice).

---

## 3  Adopt / defer decisions

### 3.1  Schedule (`dsh-schedule`) — **adopt, but opt-in**

* **Value for Cairn:** natural fit for Cairn's automation/heartbeat use cases today ("remind me to follow up on this PR", "check back every hour while this build runs"), and the upstream "active schedules in the conversation header" is a small UX win. The durability semantics (flush-before-decision, latest-only catchup) are strong and match Cairn's flush semantics elsewhere.
* **Why opt-in:** it is a **Web overlay** that must be present *before* the session starts. Sessions created before it loaded have no reminder tools. In Cairn's Electron context there's no `dsh web --patch …` equivalent — we would mount it explicitly. Gating it behind a Cairn Setting ("Enable durable reminders") under `Settings → AI → Schedule` keeps non-users untouched and avoids taking responsibility for the "no external notification" limitation.
* **Wiring if adopted:** mount `dsh-session-query-sqlite` + `dsh-schedule` (+ optionally `dsh-time-context`) in `cordis-context.ts` (`B["dsh:session-query-sqlite"] = SessionQuerySqlite`, `B["dsh:schedule"] = Schedule`) behind the setting, and add their `ENTRY_LIST` entries after `session-persistence`. The abstract `dsh-session-query` package is never mounted alone — only the sqlite backend provides `ctx.sessionQuery` (continuable subagents need it for cold resume and child listing). No new renderer slot needed initially — the three tools plus the `schedule:` projection read is enough. Web's alarm-dot (whether `schedule.active[]` is non-empty) can later surface as a pill in the chat header.

### 3.2  Subagent model selection — **defer**

* **Why defer:** benefits only multi-model deployments where the agent should autonomously route a child to a cheaper/faster model. Cairn's default is a single user-chosen provider/model; autonomous per-child routing without an explicit allowlist widens the policy surface. The upstream doc explicitly notes ACP/Codex providers **reject** this switch — our fork/spawn path would be the only one that works, so fidelity with upstream's out-of-process story would be split. Ships cleanly as a follow-up PR after the mechanical bump proves the tree boots with the new peers.
* **If adopted later:** mount `SubagentModelSelectionConfig` (via `dsh-tool-subagent/model-selection-settings`), set `tool-subagent.modelSelectionSettings:true`, add a Host Settings section (`subagent-model-selection`) bound to `allowedModels: AllowedModelRoute[]`. No renderer change — the Session-carried policy is invisible.

### 3.3  Image-capable subagent followups — **adopt passively**

* No Cairn toggle — the alpha.3 `assertImageCapable` path is automatic. Ensure `buildCordisUserContent` still routes images via `admitPromptContent` (it does). Live-cover with one coding-turn image attach test.

---

## 4  Mechanical bump — what the diff will touch

| File | Change |
|---|---|
| `package.json` | Every `@deepseek-ai/dsh-*` `^0.1.1-rc.2 → ^0.1.2-rc.1` (via `alpha.5`), `cordis 4.0.1 → 4.0.2`, add `zod ^4.4.3` if not already present; add `@deepseek-ai/dsh-session-query` + `-sqlite` (and optionally `dsh-schedule`, `dsh-time-context`); **remove** `@deepseek-ai/dsh-tool-subagent-report` (dead past `alpha.3`) and `dsh-attachment-local` (needs real sharp; restored Cairn store instead) |
| `package-lock.json` | Strip `@deepseek-ai/dsh-*` + `cordis` keys, then `npm install` — peer deadlock fix per `dsh-upgrade-guide.md` §5.2 |
| `electron/cordis/cordis-context.ts` | Mount the query backend: `import SessionQuerySqlite from "@deepseek-ai/dsh-session-query-sqlite";` → `B["dsh:session-query-sqlite"]` + an `ENTRY_LIST` entry with a derived-index `path` (`:memory:` under vitest so parallel workers don't contend). The abstract `dsh-session-query` package is never mounted alone — only the backend provides `ctx.sessionQuery`. Conditionally add `dsh-schedule` + `dsh-time-context` if opted in. |
| `electron/cordis/chat-session-runner.ts`, `cairn-plugins.ts`, `session-turn.ts`, tests | `event.seq` comparisons meet branded `SessionSeq` — runtime-safe (still numbers) but `tsc` needs `SessionSeq()` wrapping or loosened types (`chat-session-runner.ts:42,396-407`, `cairn-plugins.ts:190`, `session-turn.ts:31`, `context-ring-snapshot.test.ts:21`, `prune-replay.test.ts:58`). Prefer `session.eventAt()` / `snapshotEvents()` / `ownEvents()` where the code currently slices `session.events`. |
| `electron/cordis/run-cordis-coding.ts`, `session-runtime.ts`, tests | `SessionId(x)` → `brandString(x)` where the branded-string path is now enforced (control paths); `SessionId` still valid for session construction — migrate control-plane paths only. |
| `electron/cordis/cordis-coding-tools.ts` | Add `sessionQuery` to any diagnostics that inspect persistence (if adopted). No fs-chain change. |
| `docs/architecture-cordis.md` §8.1 | Add rows: `brandString`, `SessionSeq`/`eventAt`, `sessionQuery`, `sendMessage`/`agent-message`, `dsh-schedule (opt-in)`, `code-mode→PTC` |
| `docs/dsh-plugin-compatibility.md` | Note `sessionQuery` as ✅ provided (once mounted); mark `schedule` as 🔶 opt-in; drop `dsh-tool-subagent-report` from the matrix. |
| `changelogs/v3.0.x.md` | One line per new user-visible capability; no full diff dump. |

**Single-singleton check after install:**
```bash
find node_modules -path '*cordis/package.json' | wc -l   # → 1
grep -rn '"version": "0.1.1-rc' node_modules/@deepseek-ai/*/package.json | grep dsh- | wc -l  # → 0 at alpha.5
```

---

## 5  Phased rollout

### PR-1: Mechanical bump (no capability mounts beyond `session-query`)

1. Branch from `main`, bump `package.json` + lock, add `session-query` builtin+entry.
2. Migrate `SessionId → brandString` where control paths require it.
3. `npm run compile` + `npm run type-check:all`.
4. Live sweep `CORDIS_LIVE=1 npx vitest run electron/cordis/*.live.test.ts` (needs Rork bridge).
5. Electron QA `npm run compile && npx playwright test -c playwright.electron.config.ts` (gated on `CORDIS_LIVE=1`).
6. Update fixtures per §8.1 breaks.

**Acceptance:** tree boots, chat + coding + heartbeat forward pass, continuable `send_message`/`listAgents` no longer throw `QUERY_UNAVAILABLE`. Verify the `alpha.5` fix explicitly: bump a fixture workspace from the old tree and confirm the app starts and session titles list (the exact regression `alpha.5` repairs upstream).

#### PR-1 live-sweep log (2026-09-03, bridge `localhost:3042`, `claude-sonnet-4-5`)

Done on `ddutchie/dsh_012`. Every capability below went green at least once; residual reds across runs are model-behavior variance (documented flake class), never harness errors.

**Real alpha.5 breaks found and fixed (all in-tree, all verified live):**
- **Awaited turn-end teardown** (`session-runtime.ts` `disposeAsync`, `session-runner.ts`, `cordis-coding-tools.ts`): fiber unload is async — fire-and-forget disposal raced the next turn's same-name registrations (`tool ... is already registered`, `prompt section "cairn:system" is already registered`). Without the fix, every full-file live run cascaded after the first slow turn.
- **`user-questions` provider → waterfall** (`cairn-plugins.ts`): `registerProvider` removed upstream; the bridge now answers `user-questions/request`. Proven live (model asked, blocked, used chartreuse/axolotl same-turn).
- **Cairn attachment store restored** (`cairn-attachment-store.ts`, `cordis-context.ts`): upstream `dsh-attachment-local` needs real sharp (stubbed repo-wide) so every admission failed and images were silently dropped since Aug 23. Sharp-free store back with upstream-aligned limits; live proof is the model answering `"red"` in 1.7 s.
- **`session-query-sqlite` mount** (`cordis-context.ts`): mandatory for continuable children; `:memory:` under vitest (parallel workers contended on one file → "database is locked").
- **`Session.events` removals**: `chat-session-runner.ts` (`readSessionEvents` helper — the chat path was broken), `run-cordis-coding.ts` plan seed, `chat-session.ts` title read; `CallId` → `ToolCallId`, `snapshotEvents()` in tests; `TokenMeter` needs `sessionProjections` mounted (prune-replay, coding.live fixtures); `foldPlanMode`/`isTokenDelta` replaced by `plan-fold.ts`/inline.
- **`dsh-tool-subagent-report` dropped** (unpublished past `alpha.3`); `session-query-sqlite` + `session-query` added; `zod` → `^4.4.3`; loader → `1.0.3`.

**Stale live tests repaired (broken since the Aug 24 projection unification, not by dsh):**
- Approval confirms + plugin card filters listened for legacy `session:tool-confirm-required`; the bridge emits `session:projection` kind `"approval"` (coding-agent HITL, approval-pipeline `confirms`).
- Resume/plan tests never passed `onSessionEvent`, so token collection was always empty; approval-pipeline `runTurn` likewise (killed `finalText`); pi usage query missed the `chat-` session-id prefix.
- coding.live needed `sessionProjections` mounted + a real timeout (5 s default can never pass a model turn).

**Green at least once on alpha.5:** basic coding turn, resume (`zephyr` recalled turn 2), plan, HITL approve, skills, sandbox deny + allow, attachments (`"red"`), approval deny / session-grant / doom-halt, plugin confirm (`APPROVED:true`), ask_questions waterfall, coding-stack bash (`hello-cordis`), chat tool turn + usage rows, chat streams + resume, subagent traces, context ring.

### PR-2: Schedule, opt-in

1. Add `dsh-schedule` (+ `dsh-time-context`) mount behind a Cairn Setting `schedule.enabled` (default `false`).
2. Wire the `schedule:` projection read for the chat header alarm and a `schedule_list` poll for the automation view.
3. Unit test the flush-barrier error surfaces (`persistence_uncertain`, `schedule_not_found`, `frequency_too_high`) — no model needed.
4. Live test: `after_seconds: 30` creates → `schedule_list` shows `scheduled` → due follow-up arrives as ordinary assistant message after idle; `every_seconds: 300` catch-up is latest-only.
5. Changelog entry: "Schedule reminders (dsh-schedule) now available as an opt-in overlay (after/at/every, session-local delivery)."

### Later: Subagent model selection (PR-3, optional)

* Behind its own Setting (`subagentModelSelection.enabled + allowedModels[]`), mounts `model-selection-settings` and sets `tool-subagent.modelSelectionSettings:true`. Only in-process spawn/fork advertise it; ACP/Codex remain fixed-route.

---

## 6  Open risks & verification notes

* **Descriptor v3 read path** — verified in tarball: old logs (v2) fold as `undefined` for `agentReasoningEffort`, so historical cold resumes don't crash. Manual-check by cold-resuming a pre-bump continuable session after the bump.
* **`dsh-session-query` is now required** — forgetting it makes every `sendMessage`/`interrupt` fail closed (`CONTINUATION_UNAVAILABLE`). PR-1 must not skip it.
* **`send_message` semantics changed under our UI** — steering-at-step-boundary replaces FIFO-next-turn, and children may now message parents. Cairn's `cairnSubagentPlugin` trace renderer listens to `session/event` types (unchanged) so traces still flow, but any copy that says "the message waits until its current turn finishes" is now wrong — update user-facing strings when the bump lands. `subagent_id` → `agent_id` rename affects model-visible schema only; Cairn passes no such param itself.
* **Alpha stability** — upstream warns "developer preview, WILL break". Track the `alpha → rc` promotion; when `0.1.2-rc.x` ships, fast-follow so we exit the alpha train in one hop. Watch `https://github.com/deepseek-ai/deepseek-harness/releases` and `dsharness.org/changelog`.
* **Code-mode→PTC rename** — persisted vocabulary keeps the old `code-mode` alias; no migration needed. Grep for literal `code-mode` strings in Cairn before merging.
* **Dual ambient-zone semantics** — `dsh-schedule`'s `at` local form fails closed without an explicit zone; `dsh-time-context` (browser request zone) does **not** satisfy it implicitly. Teach the tool description to demand `time_zone` when adopting.

---

## 7  Effort estimate

* PR-1 (mechanical): **1–1.5 days** (up from 0.5–1 — the `SessionSeq` type migration touches the replay path and tests) + CI/bisect window.
* PR-2 (Schedule opt-in): **1–1.5 days** incl. projection read + Settings UI + live coverage.
* Total to `alpha.5` equivalence: **≈ 2–3 days** wall-clock, plus eligibility for fast-follow to the next RC.
* `alpha.5 → rc.1`: **~30 min** (sed + reinstall + verify) — the payoff for landing the alpha work first instead of waiting.

---

## 9  Continuable subagents — implemented on this branch

Upstream's `send_message` headline (rc.1 notes) is implemented as a full
slice: model tools, host controls, bridge, and renderer UI.

**Mounts** (`cordis-context.ts`): `tool-subagent-control` (`send_message` +
`interrupt_agent`), `tool-subagent-list-agents` (`list_agents`), a second
`tool-subagent` instance (`toolName: "delegate"`, `backgroundMode:
"continuable"` — `subagent` keeps its one-shot contract), and the background
stack `dsh-jobs-local` + `dsh-tool-jobs` (`job_output`/`job_list`/`job_kill`
+ settlement notices; required by BOTH background routes — one-shot
`run_in_background` was equally broken without a controller).

**Approval mapping** (`shared/agent/tool-risk.ts`): `delegate` /
`send_message` / `interrupt_agent` / `job_kill` → EXEC one-off (no standing
grant — overbroad for messaging); `list_agents` / `job_list` / `job_output` →
READ. Locked in `tool-risk.test.ts`.

**Bridge** (`cairn-plugins.ts` `cairnSubagentPlugin`): `agent-message`
follow-ups (either direction, incl. host→child) surface as trace tokens;
`turn/start` resets the streamed-delta guards so later turns aren't skipped.

**Host controls** (`cordis/subagent-control.ts` + `subagent:*` IPC +
preload): `list` (durable catalog + live activity overlay, anytime),
`interrupt` (durable human authority, anytime, absent = no-op), `message`
(needs the exact live parent — chat retained agents qualify, coding only
mid-turn; fails closed `parent-unavailable` with a human-readable hint).

**Renderer**: `SubagentCatalogAction` in the shared `ConversationHeader`
actions slot (Chat + Coding) — live-count badge, popover with mode/activity/
label rows, per-row message box + Stop, local reply accumulation, stable
error hints. Chat trace hook auto-materializes cold children.

**Verified live** (`subagent-continuable.live.test.ts`): delegate → durable
continuable child in catalog → host message accepted → interrupt accepted,
plus unit tests (bridge, control validation, risk).

Deliberately deferred: model-selected routes (`modelSelectionSettings`),
per-child duration/usage in the catalog, `@`-style child references, job-list
UI (upstream `ui-jobs` is read-only; no Cairn surface yet — see
`docs/dsh-ui-checklist.md`).

---

## 8  Appendix — diff sources checked

* `npm pack @deepseek-ai/<pkg>@0.1.1-rc.2` vs `@0.1.2-alpha.3` for: `dsh-agent`, `dsh-agent-loop`, `dsh-session`, `dsh-subagent`, `dsh-subagent-spawn-in-process`, `dsh-tool-subagent`, `dsh-tool-subagent-control`, `dsh-tool-subagent-report`, `dsh-schedule`, `dsh-tools`, `cordis`.
* `npm pack @deepseek-ai/<pkg>@0.1.2-alpha.3` vs `@0.1.2-alpha.4` vs `@0.1.2-alpha.5` for: `dsh-agent`, `dsh-agent-loop`, `dsh-session`, `dsh-subagent`, `dsh-tool-subagent`, `dsh-tool-subagent-control`, `dsh-schedule`, `dsh-tools`, `dsh-llm`, `dsh-session-query`, `dsh-session-persistence-jsonl`, `dsh-system-prompt`, `dsh-commands`, `dsh-compaction-basic`, `dsh-subagent-spawn-in-process`, `dsh-agent-loop-testkit`. `alpha.4 → alpha.5` `lib/` byte-identical in all 16 — version + peer bumps only.
* `npm pack @deepseek-ai/<pkg>@0.1.2-alpha.5` vs `@0.1.2-rc.1` for 20 packages (the 16 above + `dsh-llm-pi-ai`, `dsh-user-approval`, `dsh-user-questions`, `dsh-plan-mode`). `lib/` byte-identical in all 20 — version + peer bumps only.
* `npm view … dist-tags / versions --json` for `dsh-agent`, `dsh-tool-subagent-report` (dead past `alpha.3`), `dsh-subagent-fork-in-process`, `cordis`, `dsh-schedule`, `dsh-session-query`.
* Official release notes: `github.com/deepseek-ai/deepseek-harness/releases` (`alpha.4` bidirectional `send_message` + session-model chores; `alpha.5` upgrade-startup/session-title fix; `rc.1` rollup + Inspector/Web Preview app features with no published packages).
* `dsharness.org/changelog` + `deepseek-harness.github.io/.../subagent` for product framing.
* `packages/README.md` `schedule/` + `subagent/` sections confirming Schedule as **stable product API**.
