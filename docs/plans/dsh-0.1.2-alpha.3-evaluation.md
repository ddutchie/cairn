# dsh `0.1.2-alpha.3` Evaluation — Upgrade Plan for Cairn v3.0.x

> **Status:** investigation complete, plan ready — no code yet.  
> **Date:** 2026-09-01 · **Cairn pinned:** `0.1.1-rc.2` + `cordis@4.0.1` · **Proposed:** `0.1.2-alpha.3` + `cordis@4.0.2`  
> **Upstream publishes:** every `@deepseek-ai/dsh-*` at `0.1.2-alpha.3` is `npm publish`ed (tarball verified). `alpha.1` was tag-only, not published — use `alpha.3`.  
> **Generic bump playbook:** [`docs/dsh-upgrade-guide.md`](../dsh-upgrade-guide.md)

---

## TL;DR

* **Scope:** 1079 commits vs `rc.2` (master `cd5ef8148`), 241 dsh-family packages (+9 vendor). The diff is not a patch — it's an **alpha train** with architecture-level changes.
* **For Cairn, the win is real:** durable `schedule` reminders ("remind me in 10 min…"), subagent model routing (`provider/model/reasoning_effort` + `list_subagent_models`), image-capable subagent followups, a real tool-call scheduler, and a `sessionQuery` projection cache that makes cold subagent listing fast.
* **Risk is contained if adopted in two phases:** mechanical bump (no new mounts) is low-risk; capability enablement is opt-in. The one mandatory migration is the descriptor bump `2→3` and the move from `SessionId()` to `brandString()` — both backward-compatible for reads.
* **Recommendation:** land as **two PRs** — (PR-1) mechanical bump to `alpha.3` with zero capability mounts (prove the tree still boots), then (PR-2) enable **Schedule** as an opt-in Cairn Setting while deferring model-selected subagents. Flip `alpha → rc` when the upstream RC that pulls these changes forward ships, so we exit the alpha track quickly.
* **Why the user saw "schedule messages to subagents":** upstream's `dsh-schedule` **is** "schedule a message to yourself later" — a durable follow-up delivered as an ordinary message in **the same session**, not an inter-agent scheduler. The subagent improvement in this train is **model-selected routing** and **image forwarding**, not scheduled delivery. `dsh-schedule` and `ctx.subagents` are orthogonal seams.

---

## 1  What shipped in `0.1.2-alpha.3` (vs our `0.1.1-rc.2`)

### 1.1  Cordis 4.0.1 → 4.0.2 (minor, must move together)

* `@deepseek-ai/cosmokit 1.8.2→1.8.3`, `@deepseek-ai/cordis-plugin-loader 1.0.2→1.0.3`, `@deepseek-ai/cordis-plugin-include 1.0.6→1.0.7` — no Cairn behavioral change; `loader.builtins` shape unchanged.

### 1.2  `dsh-schedule` — the headline "schedule a message" feature

* **Package:** `@deepseek-ai/dsh-schedule@0.1.2-alpha.3` (npm tag `alpha`). Previously at `rc.2` with the same tool names but a much thinner projection layer.
* **Tools:** `schedule_create` / `schedule_list` / `schedule_delete` via `ctx.schedule` (agent-scoped, root agents only). Selectors: `after_seconds` (delay), `at` (RFC3339 `Z`/offset **or** `{date, time, time_zone:IANA}`), `every_seconds` (≥5 min, anchor-aligned). Every create stores canonical UTC `scheduledAt`; dispatch appends `acceptedAt` and advances `every` directly to the next anchor target (no backlog replay — latest-only).
* **Durability:** `schedule/change` version-1 events (create/delete/dispatch) own state; timers + follow-ups are disposable projections. Every read/decision awaits `ctx.sessions.flush(session)`; an absent persistence returns `persistence_uncertain`, not a false answer.
* **Delivery:** due one-shots have priority, then batched `every`s in target+creation order; enters one later turn via `Agent.followup()` **after** idle maintenance is claimed (`runMaintenance()`). Never steers/interrupts the current turn; dispatch means queued+recorded, not "model succeeded".
* **Projection (new in alpha.3):** optional `schedule` projection unit `{seedLength, active, seenIds}` sharing `applyScheduleChanges` with full replay. Enables read-only active-reminder catalog (and the Web's alarm-dot) without scanning the log. Forks slice `events.slice(seedLength)` so children don't inherit parent reminders.
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
| **Session query** | Continuable cold-resume and `listChildren` now go through `@deepseek-ai/dsh-session-query` (`query.observeSession`, `query.listSessions`) instead of raw `persistence.inspect`. Requires the `sessionQuery` service (`dsh-session-query`). | Mounting `dsh-session-query` becomes mandatory for continuable children once bumped. If Cairn doesn't mount it, `followup(continuable)` and `listAgents` will throw `CONTINUATION_UNAVAILABLE` / `SUBAGENT_CONTROL_QUERY_UNAVAILABLE`. Mechanical bump without the mount **breaks continuable subagents**. |
| **Typert** | `dsh-subagent` gains `typert.host` / `typert.remote-client` entries, `RemoteError`/`TypertRemoteService`, control validation via `zod`. | New deps `dsh-brand`, `dsh-util-values`, `dsh-util-time` pulled in transitively. |
| **Branded strings** | `SessionId(x)` string construction replaced by `brandString(x)` across subagent/control paths. | Cairn must migrate its own `SessionId(...)` calls (in `coding-agent.live.test.ts`, `session-runtime.ts`, etc.) — mechanical search/replace. |

### 1.4  Agent loop + session

* **Tool-call scheduler:** rolling bounded pool (`maxParallelToolCalls`), ordered commits, drain-on-failure, idle-latch wakeup — replaces the ad-hoc loop. No Cairn contract change, but live tool-call ordering fidelity improves.
* **`turnBoundary` projection:** `stateOf(session,"turnBoundary").lastTurn` replaces `session.events.findLast(e=>"turn/start").data.turn` — Cairn doesn't read this directly today, but is a signal that turn counting is now projection-backed.
* **`SessionId` / string branding:** harder typing (`Branded<'SessionId'>`) via `@deepseek-ai/dsh-brand`; helpers via `dsh-util-values` (`snapshotJsonValue`), `dsh-util-time` (`canonicalClientTimeZone`).
* **Session format:** `SESSION_FORMAT_VERSION` still `0` (no migration step). Per-session `projection_cache.json` + strict checkpoint schema for cold-read seeding.

### 1.5  Alpha.1 global refactor (inherited, not alpha.3-specific but ships now)

* `dsh-client-runtime → dsh-client-modules` (lazy CJS module table), `ApiProxy` package deleted (replaced by `Remote` controllers), `code-mode → PTC mode` rename, `CallId → ToolCallId`. Cairn doesn't use the client/module system directly today (we use our own Next.js renderer), so impact is documentation-only — but any community plugin author targeting the new Web shell must rebuild against alpha.3.

---

## 2  Impact on Cairn's mounted tree

### What Cairn mounts today (from `electron/cordis/cordis-context.ts`)

```
session, llm, system-prompt, agent, tools, user-questions, approval,
session-persistence (jsonl), agent-loop, attachment-store, token-meter,
tool-result-pruner, compaction, llm-retry, subagent (+spawn), tool-subagent,
skills, invariants, tool-skill, commands, plan-mode, session-title, projection-registry
(+ per-turn coding stack: sandbox-local/policy, fs-sandbox, bash-sandbox, shell-env, tool-bash/fs/fs-search/str-replace/todo)
```

### What alpha.3 changes about that list

* **Mandatory new transitive peers** (bump-time, even if no new capability mounted): `zod ^4.4.3`, `@deepseek-ai/dsh-brand`, `@deepseek-ai/dsh-util-values`, `@deepseek-ai/dsh-util-time`. Already peer-required by `dsh-subagent`/`dsh-agent-loop` — must be present in `package-lock` or `npm install` fails to dedupe singletons.
* **Newly-required service for continuable subagents:** `@deepseek-ai/dsh-session-query`. Bump without adding it to the `B` map and `ENTRY_LIST` **regresses** continuable followups. Fix: add it (it's local persistence, not networked).
* **Optional mounts (deferrable):** `dsh-schedule` (+ `dsh-time-context` for natural-language zone inference), `model-selection-settings` service (only if we enable subagent model choice).

---

## 3  Adopt / defer decisions

### 3.1  Schedule (`dsh-schedule`) — **adopt, but opt-in**

* **Value for Cairn:** natural fit for Cairn's automation/heartbeat use cases today ("remind me to follow up on this PR", "check back every hour while this build runs"), and the upstream "active schedules in the conversation header" is a small UX win. The durability semantics (flush-before-decision, latest-only catchup) are strong and match Cairn's flush semantics elsewhere.
* **Why opt-in:** it is a **Web overlay** that must be present *before* the session starts. Sessions created before it loaded have no reminder tools. In Cairn's Electron context there's no `dsh web --patch …` equivalent — we would mount it explicitly. Gating it behind a Cairn Setting ("Enable durable reminders") under `Settings → AI → Schedule` keeps non-users untouched and avoids taking responsibility for the "no external notification" limitation.
* **Wiring if adopted:** mount `dsh-session-query` + `dsh-schedule` (+ optionally `dsh-time-context`) in `cordis-context.ts` (`B["dsh:session-query"] = SessionQuery`, `B["dsh:schedule"] = Schedule`) behind the setting, and add their `ENTRY_LIST` entries after `session-persistence`. No new renderer slot needed initially — the three tools plus the `schedule:` projection read is enough. Web's alarm-dot (whether `schedule.active[]` is non-empty) can later surface as a pill in the chat header.

### 3.2  Subagent model selection — **defer**

* **Why defer:** benefits only multi-model deployments where the agent should autonomously route a child to a cheaper/faster model. Cairn's default is a single user-chosen provider/model; autonomous per-child routing without an explicit allowlist widens the policy surface. The upstream doc explicitly notes ACP/Codex providers **reject** this switch — our fork/spawn path would be the only one that works, so fidelity with upstream's out-of-process story would be split. Ships cleanly as a follow-up PR after the mechanical bump proves the tree boots with the new peers.
* **If adopted later:** mount `SubagentModelSelectionConfig` (via `dsh-tool-subagent/model-selection-settings`), set `tool-subagent.modelSelectionSettings:true`, add a Host Settings section (`subagent-model-selection`) bound to `allowedModels: AllowedModelRoute[]`. No renderer change — the Session-carried policy is invisible.

### 3.3  Image-capable subagent followups — **adopt passively**

* No Cairn toggle — the alpha.3 `assertImageCapable` path is automatic. Ensure `buildCordisUserContent` still routes images via `admitPromptContent` (it does). Live-cover with one coding-turn image attach test.

---

## 4  Mechanical bump — what the diff will touch

| File | Change |
|---|---|
| `package.json` | Every `@deepseek-ai/dsh-*` `^0.1.1-rc.2 → ^0.1.2-alpha.3`, `cordis 4.0.1 → 4.0.2`, add `zod ^4.4.3` if not already present; add `@deepseek-ai/dsh-session-query` (and optionally `dsh-schedule`, `dsh-time-context`) |
| `package-lock.json` | Strip `@deepseek-ai/dsh-*` + `cordis` keys, then `npm install` — peer deadlock fix per `dsh-upgrade-guide.md` §5.2 |
| `electron/cordis/cordis-context.ts` | Add `import SessionQuery from "@deepseek-ai/dsh-session-query";` to `B["dsh:session-query"]`; add its `ENTRY_LIST` entry; conditionally add `dsh-schedule` + `dsh-time-context` if opted in. |
| `electron/cordis/run-cordis-coding.ts`, `session-runtime.ts`, tests | `SessionId(x)` → `brandString(x)` where the branded-string path is now enforced (control paths); `SessionId` still valid for session construction — migrate control-plane paths only. |
| `electron/cordis/cordis-coding-tools.ts` | Add `sessionQuery` to any diagnostics that inspect persistence (if adopted). No fs-chain change. |
| `docs/architecture-cordis.md` §8.1 | Add rows: `brandString`, `sessionQuery`, `dsh-schedule (opt-in)`, `code-mode→PTC` |
| `docs/dsh-plugin-compatibility.md` | Note `sessionQuery` as ✅ provided (once mounted); mark `schedule` as 🔶 opt-in. |
| `changelogs/v3.0.x.md` | One line per new user-visible capability; no full diff dump. |

**Single-singleton check after install:**
```bash
find node_modules -path '*cordis/package.json' | wc -l   # → 1
grep -rn '"version": "0.1.1-rc' node_modules/@deepseek-ai/*/package.json | grep dsh- | wc -l  # → 0 at alpha.3
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

**Acceptance:** tree boots, chat + coding + heartbeat forward pass, continuable `send_message`/`listAgents` no longer throw `QUERY_UNAVAILABLE`.

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
* **`dsh-session-query` is now required** — forgetting it makes every `followup`/`interrupt` fail closed (`CONTINUATION_UNAVAILABLE`). PR-1 must not skip it.
* **Alpha stability** — upstream warns "developer preview, WILL break". Track the `alpha → rc` promotion; when `0.1.2-rc.x` ships, fast-follow so we exit the alpha train in one hop. Watch `https://github.com/deepseek-ai/deepseek-harness/releases` and `dsharness.org/changelog`.
* **Code-mode→PTC rename** — persisted vocabulary keeps the old `code-mode` alias; no migration needed. Grep for literal `code-mode` strings in Cairn before merging.
* **Dual ambient-zone semantics** — `dsh-schedule`'s `at` local form fails closed without an explicit zone; `dsh-time-context` (browser request zone) does **not** satisfy it implicitly. Teach the tool description to demand `time_zone` when adopting.

---

## 7  Effort estimate

* PR-1 (mechanical): **0.5–1 day** + CI/bisect window.
* PR-2 (Schedule opt-in): **1–1.5 days** incl. projection read + Settings UI + live coverage.
* Total to `alpha.3` equivalence: **≈ 2 days** wall-clock, plus eligibility for fast-follow to the next RC.

---

## 8  Appendix — diff sources checked

* `npm pack @deepseek-ai/<pkg>@0.1.1-rc.2` vs `@0.1.2-alpha.3` for: `dsh-agent`, `dsh-agent-loop`, `dsh-session`, `dsh-subagent`, `dsh-subagent-spawn-in-process`, `dsh-tool-subagent`, `dsh-tool-subagent-control`, `dsh-tool-subagent-report`, `dsh-schedule`, `dsh-tools`, `cordis`.
* `npm view … dist-tags / versions --json` for `dsh-agent`, `cordis`.
* `dsharness.org/changelog` + `deepseek-harness.github.io/.../subagent` for product framing.
* `packages/README.md` `schedule/` + `subagent/` sections confirming Schedule as **stable product API**.
