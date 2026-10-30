# Cairn agent engine — design

> Branch: `refactor/remove-dsh` · 2026-10-30 · Status: **draft for review**
> Companion to `docs/plans/remove-dsh.md` (Phases 2–5). That plan says *what is
> replaced and when*; this one says *what we build*.

## Decisions taken

| Topic | Decision |
|---|---|
| Permissions | **Rules as data** (editable allow / ask / deny rules + presets), not hard-coded name sets |
| Cairn writes (notes, tasks, board, idea flow) | **Allowed by default** in chat and coding — too interactive otherwise |
| Auto mode | Claude-Code-style guardrail (§5): input guard + two-stage, reasoning-blind action reviewer, trusted-environment config, protected paths, escalation to manual after 3 consecutive / 20 total blocks |
| Loops | One loop; chat / coding / automation / subagent are **profiles** |
| History | `cairn-session/v1` log + frozen dsh importer (see `remove-dsh.md` §3) |

---

## 1. Shape

```
electron/agent/
  events.ts     AgentEvent union (zod) — the only thing the loop emits
  loop.ts       runTurn(): async generator over AgentEvent
  policy.ts     decide(call, state) → Decision      (pure, sync)
  rules.ts      Rule schema, matching, presets, store
  gate.ts       asks: registry, transports, timeouts, durable re-emit
  reviewer.ts   auto-mode two-stage action reviewer (§5)
  inputguard.ts auto-mode injection scan of untrusted tool results + turn taint (§5)
  context.ts    derived model view: compaction, pruning, image offload
  tools/        defineTool(), registry, builtins (cairn, fs, bash, web, mcp)
  session/      log writer/reader, projections, dsh importer
  profiles.ts   chat | coding | automation | heartbeat | subagent
```

`pi-ai` supplies `streamSimple`, typed messages/usage/cost, `validateToolCall`,
`isContextOverflow`, retry, and a `faux` provider. Everything above is ours.

### The loop

```ts
async function* runTurn(s: Session, input: UserInput, p: Profile, h: Host): AsyncGenerator<AgentEvent> {
  yield turnStart(...);
  while (true) {
    const view = buildContextView(s, p);                       // derived, never mutates the log
    const msg  = yield* streamAssistant(view, p.model, s.signal); // deltas + retry + overflow→compact
    if (msg.stopReason !== "toolUse") break;
    const calls = msg.toolCalls.map(validate);                 // bad args → error result, no gate
    yield* gateAll(calls, s, p, h);                            // §3–5: decide → review → ask
    yield* execute(calls);                                     // parallel reads, exclusive writes
  }
  yield turnEnd(...);
}
```

Every event is appended to the log **before** the side effect it describes
(`tool/call` is written before the tool runs). On resume, calls without a
result get a synthetic `interrupted` result so the history stays valid for the
provider. The renderer's live stream and replay are folds over the same events.

---

## 2. Tools carry their own risk

```ts
defineTool({
  name: "bash",
  schema,                                   // typebox
  risk: (args) => ({ class: "EXEC", reads: [], writes: [], network: false }),
  preview: (args) => args.command,
  concurrency: "exclusive",                 // | "parallel"
  execute: async (args, ctx) => ...
})
```

Risk classes stay `READ | WRITE_CAIRN | WRITE_LOCAL | EXEC | EXTERNAL` (today's
`tool-risk.ts` minus the name sets). `risk()` is **args-aware** (`str_replace_editor`
`view` is READ; a write inside the workspace is not a write outside it). Unknown
or throwing `risk()` ⇒ treated as `EXEC` (fail closed). This replaces
`shared/agent/tool-risk.ts`, which already misclassified `spawn_subagent`
because the name matched nothing registered.

`WRITE_CAIRN` is new: Cairn's own data (notes, cards, idea flow, tags). It is
split out so the "allowed by default" decision is one preset, not a hack.

---

## 3. Rules as data

```ts
interface Rule {
  id: string;
  effect: "allow" | "ask" | "deny";
  match: {
    tool?: string;                 // glob: "mcp__github__*"
    risk?: RiskClass[];
    command?: { exact?: string; prefix?: string[] };  // bash; token-prefix, shell-parsed
    path?: { within?: "workspace" | string };          // glob/dir
    host?: string;                                     // web_fetch / external
  };
  scope: "session" | "workspace" | "global";
  source: "preset" | "user" | "grant" | "classifier-learned";
  note?: string;
  expiresAt?: number;
}
```

* **Precedence:** `deny` > `ask` > `allow`; first match within an effect wins on
  specificity (exact > prefix > glob). No match ⇒ falls through to §4.
* **Bash is conservative:** exact or token-prefix only; any command containing
  `&&`, `||`, `;`, `|`, `` ` ``, `$()`, redirects or heredocs never matches a
  prefix rule. Wildcard exec grants are refused (same stance as automation
  standing rules today).
* **Storage:** SQLite `permission_rules` (scope-keyed) with JSON import/export;
  session-scope rules also written to the session log so they survive reload
  and are visible in replay.
* **Presets** are rule bundles, shipped as data:
  * `cairn-data` — allow `WRITE_CAIRN` (**default on** in chat + coding)
  * `workspace-edits` — allow `WRITE_LOCAL` with `path.within = workspace`
  * `read-only` — deny everything but `READ` (plan mode, enforced not advisory)
  * `safe-shell` — allow a short list of read-only commands (`ls`, `git status`…)
  * `ask-shell`, `ask-network` — explicit asks
* **Settings → Permissions:** list/edit rules, plus a **dry-run console**
  ("what happens if the agent runs `rm -rf build`?") — free, because `decide`
  is pure.
* Every ask card offers *Allow once / Always for this {command|tool|path} /
  Deny / Deny always*; "Always" creates a `grant` rule, fixing the inert
  `grant:"command"` and turn-scoped grant gaps from the audit.

---

## 4. Policy pipeline

```
decide(call, state):
  1. profile hard-deny            (e.g. chat has no bash)           → deny
  2. mode "plan"/read-only        (enforced)                        → deny non-READ
  3. rules                        deny → ask → allow                → decided
  4. doom-loop (≥3 identical)                                       → ask (cannot be auto-allowed)
  5. risk class defaults for the profile+mode
        protected path → ask · READ → allow · WRITE_CAIRN → allow (preset)
        workspace edit → allow (preset) · rest → "unresolved"
  6. unresolved → by mode:
        ask       → ask the human
        auto      → reviewer (§5), then human if it says ask / on failure
        autoApprove (yolo) → allow
```

`decide` is **pure and synchronous** and returns `allow | deny{reason} |
ask{spec} | review{spec}`. The `Gate` runs the async part (reviewer, human).
Doom-loop sits *before* any ask or review so it can no longer be bypassed by
an ask short-circuit (audit G3).

### The Gate (human asks)

* One registry keyed `(sessionId, callId, nonce)` — no cross-session
  resolution (G4).
* Asks are **events in the log** (`approval/asked`, `approval/decided`). A
  reconnecting renderer receives `pendingAsks` in its snapshot, so a reload no
  longer deadlocks (G5).
* TTL on every ask, fail-closed (G6). Abort signal resolves all asks of a turn.
* Transports are pluggable: desktop card, mobile, headless automation inbox.
* Batching: parallel calls that all need asks are shown as one group with
  *approve all / review each*.

---

## 5. Auto mode — a guardrail model reviews the call

Goal: routine work proceeds without prompts, risky or irreversible work is
stopped, and a stop always comes with **why**. Shape follows the Claude Code
auto-mode description the team reviewed (two layers, two stages,
reasoning-blind, escalation back to manual), adapted to Cairn's tools.

> Auto mode is a guardrail, not a security boundary. The classifier can be
> wrong when intent is ambiguous or context is missing; the sandbox, deny
> rules and protected paths remain the hard stops. Settings copy says so.

### Two layers

1. **Input guard** — untrusted content is scanned *before* it enters context.
   Sources: `web_fetch`/`web_search`, MCP/external tool output, shell output,
   file reads outside the workspace. A cheap heuristic + small-model probe looks
   for injected instructions. On a hit the result is wrapped in an
   *untrusted-content* banner (span redacted when it can be isolated), an
   `input/flagged` event is logged, and the turn becomes **tainted**: while
   tainted, calls that would auto-allow are sent through stage 2 (or to the
   human) instead. Taint clears on the next user message.
2. **Action reviewer** — every call that reaches "unresolved" in §4 is reviewed
   before it runs.

### Where the reviewer sits

Handled without the reviewer (deterministic, cheap): READ tools, Cairn-data
writes (`WRITE_CAIRN` preset), workspace edits (`workspace-edits` preset, minus
**protected paths**), anything matched by a rule. Routed to the reviewer:
shell, network, pushes/deploys, MCP/external calls, writes outside the
workspace, unknown tools. It can only resolve `unresolved` → `allow | block |
ask`; it can **never** override a hard deny, a `deny` rule, plan mode, protected
paths or the sandbox.

### Two stages

* **Stage 1 — fast filter:** small model, tiny prompt, near-single-token
  output (`allow` / `flag`). Most calls end here.
* **Stage 2 — deliberate review:** runs only on `flag` (or while tainted).
  Reasons step-by-step over the same inputs and returns the full verdict below.

```ts
type Verdict = {
  verdict: "allow" | "block" | "ask";
  reason: string;                 // ≤ 200 chars, shown to the user and fed back to the model
  tags: ("destructive" | "irreversible" | "exfiltration" | "off-task" |
         "credential" | "persistence" | "untrusted-destination" | "unclear")[];
  matchesUserIntent: boolean;
};
```

### What the reviewer sees (reasoning-blind)

| Included | Excluded |
|---|---|
| The user's messages (trusted) | **Tool results** (injection vector) |
| The proposed call: tool, args (secret-scrubbed), risk class, preview | **The agent's own text and reasoning**, including any "why I'm doing this" |
| Profile, mode, cwd, sandbox state, summary of active rules | Other sessions |
| The trusted-environment config (below) and user guidance text | |

Agent-authored explanations are excluded entirely: they are exactly what an
injected instruction would try to steer. If the call can't be justified from the
user's messages, the verdict is `ask` (or `block` when it also hits a risk tag).

### Trusted environment

Default trust is narrow: the workspace directory, Cairn's own data, and the
current repo's configured git remotes. Anything else — another remote, a cloud
bucket, an unfamiliar domain, an unlisted MCP server — is
`untrusted-destination` and blocked until declared. Config (Settings →
Permissions → Environment, stored with the rules):

```ts
interface AutoEnvironment {
  trustedPaths: string[];          // beyond the workspace
  trustedRemotes: string[];        // auto-detected from git + user additions
  trustedDomains: string[];        // web_fetch / curl destinations
  trustedMcpServers: string[];
  guidance?: string;               // free text appended to the reviewer prompt:
                                   // "we deploy via `make ship`; that's fine"
}
```

Defaults worth stating: `git push` / PRs to the current repo's remote are
allowed (including the default branch); force-push, history rewrites, branch
deletion and pushes to other remotes go to the reviewer and are usually blocked.

### Protected paths

Always `ask` (never auto-allowed, even inside the workspace): `.git/`,
`.env*`, key/credential files, shell rc files, `.cairn/` config, CI workflow
files, and the rules store itself. User-extendable.

### Verdict handling and escalation

* `allow` → runs; chip *Auto-approved — {reason}* (model, latency, cost on
  expand). Logged as `approval/decided { by: "reviewer", stage, model, reason }`.
* `block` → the tool returns an error to the model: *"Blocked by safety review:
  {reason}. Find a safer approach or ask the user."*
* `ask` → normal approval card, headline = the reviewer's reason.
* Reviewer error / timeout / malformed output → `ask` (fail closed).
* **Escalation:** after **3 consecutive blocks** or **20 total in a session**
  auto mode pauses and the session drops to manual `ask` until the user
  re-enables it. A banner explains why.
* **Recently denied** (Settings → Permissions, also surfaced in the transcript):
  every block/deny with its reason; one click to *allow once & retry*, *allow
  always* (creates a rule) or *add to environment* (for untrusted-destination).

### Model, cost, privacy

* Separate settings for stage 1 and stage 2 models (default: small/fast on the
  session's provider; stage 2 may be the session model). Either can point at a
  **local** model so command text never leaves the machine.
* Args pass through the secrets scrubber first.
* Verdict cache `(canonical call, rules hash, environment hash, user-turn id)`;
  parallel calls reviewed in one request.
* Usage booked under sources `reviewer-1` / `reviewer-2` / `input-guard` so
  Usage shows what auto mode costs.

### Closing the loop

Overriding the reviewer (approving a `block`/`ask`, or denying an `allow`)
offers **"Make this a rule"** → `source: "classifier-learned"`. Reviewer volume
should fall as rules and environment grow.

### How we know it works

Real ground truth exists: existing sessions contain `approval/asked` →
`approval/decided` pairs. The importer exposes them; an eval harness replays
historic calls through both stages and reports agreement with the user,
false-allow rate, ask rate, latency and cost per stage. Plus a red-team set:
injected instructions in fetched pages (to test the input guard *and* the
reviewer separately), exfiltrating `curl`, `rm` outside cwd, credential reads,
`git push --force`, shell-rc persistence, a call that is only "justified" by
agent text. Auto mode ships behind a setting until the red-team false-allow rate
is zero and agreement on real history is acceptable (thresholds set after the
first numbers).

---

## 6. Modes × profiles

| Mode | Behaviour | Default for |
|---|---|---|
| `ask` | unresolved → human | coding (first run) |
| `auto` | unresolved → reviewer → human | opt-in; candidate default later |
| `yolo` (autoApprove) | unresolved → allow; deny rules + sandbox still apply | chat (Cairn tools) |
| `plan` | non-READ → deny (enforced) | any, per session |

Automation / heartbeat runs have no human: `ask` resolves through the durable
automation inbox, `auto` falls back to **deny** (not allow) when the reviewer
says `ask`, and standing rules apply as today.

Subagents inherit the parent's rules **narrowed**: a child can never hold
more authority than its parent; its asks surface in the parent's UI with the
child named, and reviewer verdicts record the child session.

---

## 7. Context, compaction, session log

* The log is append-only and complete. `context.ts` builds the **model view**
  from it: summaries replace spans, tool results are pruned, images offloaded.
  Compaction/pruning are events; undoing or inspecting them never loses data.
* `isContextOverflow` from `pi-ai` triggers a compaction retry mid-turn.
* Projections (todos, plan, stats, context ring, title) are folds registered
  once and used for both live and replay.

---

## 8. Testing

1. **Kernel tests on `pi-ai`'s `faux` provider** — scripted assistant messages
   drive the whole loop: allow/deny/ask paths, abort mid-ask, crash-resume,
   doom-loop, parallel tools, overflow→compaction. No network.
2. **Policy tables** — `decide` is pure: a table of (rules, call, mode) →
   decision, including adversarial bash strings.
3. **Reviewer** — unit tests with a faux reviewer for plumbing (block → model
   sees reason, 3-strike escalation, fail-closed); quality via the eval harness
   in §5 on live models.
4. **Port, don't rewrite, the live tests** in `electron/cordis/*.live.test.ts`.

---

## 9. Build order

1. `events.ts`, `loop.ts`, `policy.ts`, `rules.ts`, `gate.ts` + faux-provider tests (no UI).
2. Port the `dsh-llm-pi-ai` patch behaviour (tool-call streaming, reasoning
   replay) — **read the patch first**; this is where provider quirks live.
3. Session log + adapter mapping `AgentEvent` → today's `session:event` /
   `session:projection` channels so the renderer is unchanged.
4. Chat profile on the toggle; then coding; then the rest (`remove-dsh.md` §4).
5. Input guard, two-stage reviewer, environment config, eval harness — behind a setting.
6. Settings → Permissions UI (rules, presets, dry-run, environment, recently denied).

## 10. Open questions

* Reviewer default model per provider when the user has only one configured.
* Do we show reviewer verdicts inline for every auto-approved call, or collapse
  them into a per-turn summary ("5 calls auto-approved")?
* Path-scoped rules for MCP tools — is `host`/`tool` matching enough?
* Should `global` rules be syncable across devices (sync layer exists)?
