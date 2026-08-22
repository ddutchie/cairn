# Approval-Gating Audit — dsh ↔ Cairn

How approval requests travel from the dsh loop through Cordis to the Cairn UI
and back, what the native dsh contract provides, where our bridge deviates or
breaks, and the phased fix plan. Sources: parallel audits of (1) the main-process
stack, (2) the renderer UX, (3) native `dsh-user-approval` /
`dsh-permission-presets` + upstream repo at `dsh-v0.1.1-rc.2`.

---

## 1. The flow (coding agent, autoApprove OFF)

```
dsh tools scheduler            prepareExecution → ctx.waterfall("tools/pre-execute")
                                   │ return {kind:"ask"} short-circuits the chain
cairnApprovalPlugin             (1) ask-classifier: tool ∉ APPROVAL_SAFE && !sessionGranted
  electron/cordis/cairn-plugins.ts:767   → {kind:"ask"}
mounted per turn by                (2) answerer on "approval/request":
run-cordis-coding.ts:169              emit pi-agent:tool-confirm-required {sessionId,name,label,callId}
                                      block on registerPending(callId, resolver)
dsh-user-approval               ApprovalService.request(): appends approval/asked (jsonl),
  service "dsh:approval"        dispatches waterfall, appends approval/decided.
  mounted run-cordis-loop.ts:295,355   Outcomes: allowed-once|rejected|cancelled|unavailable
renderer                        AgentChatPane onToolConfirmRequired → setPiToolConfirmRequired
                                   → ToolChip renders <ApprovalCard>
response                        Deny/Allow-once/Always-allow-{command,tool}
                                   → pi-agent:respond-tool {sessionId,callId,approved,grant}
main                            cordisPendingApprovals.get(callId) resolver fires
  pi-agent.ts:627 (sessionId VOIDED — global map keyed by callId only)
back                            resolver → "allowed-once"/"rejected" → dsh dispatches or denies
```

Pending maps live module-level in `pi-agent.ts:52–54`:
`cordisPendingApprovals` (callId), `cordisPendingDoomLoop`
(`${sessionId}:${signature}`), `cordisPendingQuestions` (requestId).
Headless analogue: `pendingAutomationApprovals` (heartbeat-runner.ts:99).

**Chat path has NO gating**: `runCordisLoop` mounts neither the approval nor
doom-loop plugin (:609–632); every chat tool executes unconditionally.

## 2. Decision inputs

| Input | Mechanism | Notes |
|---|---|---|
| autoApprove toggle | renderer setting (default **true**) → llmConfig.autoApprove | plugin not even mounted when true |
| Forced-on rule | no approvals adapter ⇒ silently forced ON (run-cordis-coding.ts:112) | headless safety valve |
| APPROVAL_SAFE allowlist | hardcoded read-only names (cairn-plugins.ts:730–740) | everything else asks incl. dsh write/edit/bash |
| sessionGranted Set | tool names granted via `grant:"session"` | **turn-scoped** — disposed in loop finally |
| grant:"command" | accepted end-to-end… | **inert** — only `"session"` is checked (:802) |
| Doom loop | separate pre-execute guard, threshold 3 identical signatures | blind when approval plugin short-circuits (§3 G7) |
| Automation policy | ask/auto modes + DB-persisted standing rules (automation-approval.ts) | refuses wildcard exec grants |
| Plan mode | advisory only — no read-only enforcement | dsh-owned; presets would change this |

## 3. Gap register (prioritized)

**P0 — correctness bugs**
- **G1 Inert `grant:"command"`**: UI offers "Always allow this command" for bash
  (AgentMessageBubble.tsx:87); nothing consumes it → behaves as allow-once while
  promising more. Users stop reading prompts believing grants exist.
- **G2 Turn-scoped "Always allow this tool"**: `sessionGranted` dies with the
  per-turn plugin mount (run-cordis-coding.ts:314 finally). Next prompt re-asks
  everything. Upstream has NO grant store either — this is ours to build.
- **G3 Doom-loop blind spot**: the ask-classifier returns `{kind:"ask"}` WITHOUT
  `next()`, so the waterfall short-circuits and `cairnDoomLoopPlugin` never sees
  un-granted mutating calls. A denied-then-retried identical bash/write never
  trips the guard precisely when autoApprove is off (protection inverted!).
- **G4 Cross-session race**: respond-tool ignores sessionId (void :628); global
  callId map shared across concurrent coding+automation turns. Stale/malicious
  event could resolve another session's ask.

**P1 — resilience**
- **G5 Reload deadlock**: no webContents destroy/reload hook; Zustand confirm
  state lost; `pi-agent:is-running` returns only a boolean; main promise blocks
  forever until Stop. Upstream apiproxy solves this with stable rpcId frames +
  replay-on-reconnect (api-proxy.ts:1362–1436) — that's the template.
- **G6 No timeouts**: interactive asks wait indefinitely (automation DB inbox had
  10-min fail-closed; replacement dropped it). Resolver leak paths: destroy/
  teardown don't sweep maps; `{once:true}` abort listeners linger.

**P2 — consistency / architecture**
- **G7 Two divergent taxonomies**: main `APPROVAL_SAFE` vs renderer
  `tool-risk.ts`. Drift: `str_replace_editor` gated in main but READ/no-grant in
  UI; `update_note` asked in main, READ in UI; new tools must land twice.
- **G8 Three near-identical bridges**: interactive (approvalPlugin+maps),
  headless (`shouldAutoAllowAutomationTool`+map), legacy DB inbox
  (`makeApprovalGate`, unused on Cordis path) — diverged on timeouts/grants.
- **G9 Chat ungated** (by design today; trap when mutating chat tools arrive).
- **G10 Plan mode advisory**: autoApprove=true planning agent can freely mutate;
  real fix is dsh-sandbox-policy read-only mode, not prompt guidance.
- **G11 Headless asks lose args** (heartbeat stores `args:{}`) → standing rules
  bind without targets for non-exec tools.
- **G12 Subagent chips can't confirm**: `setPiToolConfirmRequired` walks only
  top-level toolCalls; subagent calls never surface/retire cards.
- **G13 Mobile parity zero**: no approval/doom/question UI on mobile at all.
- **G14 UX polish**: no disabled/latch states on ApprovalCard/doom buttons;
  no aria-live/out-of-viewport cue; doom count shows static threshold 3.

## 4. What dsh gives us natively (adoption opportunities)

1. **`dsh-sandbox-policy`** (`read-only|workspace-write|danger-full-access`) —
   we currently hard-default `danger-full-access` (cordis-coding-tools.ts:121).
   Adopting confinement migrates part of the gating INTO the sandbox (bash
   writes outside workspace become native denials with escalation), fixes G10
   properly, and unlocks:
2. **`dsh-permission-presets`** — bundles sandbox-mode + approval-policy per
   SESSION with `/permission` command, durable `permission/preset` +
   `approval/policy` folds, and throws unless an executor confines. Replaces
   our boolean autoApprove with the native `ask|never` fold (autoApprove ≈ pin
   `never`). Orthogonal to APPROVAL_SAFE — presets cannot express per-tool rules.
3. **Subagent pinning is free**: dsh-subagent stamps child
   `approval/policy: never` (children never prompt; deterministic reject).
4. **Audit events exist already**: every ask writes `approval/asked|decided`
   pairs to the jsonl log — we can render decisions in transcripts for free.
5. **No upstream grant store**: README states only one-shot grants exist. Our
   session/command grants remain Cairn-owned code — design them like automation
   standing rules (persisted, target-aware, exec-refuses-wildcard).
6. **Bridge shape matches upstream**: emit→block→resolve mirrors apiproxy minus
   replay; adopt its rpcId frame pattern for G5 rather than inventing.

## 5. Fix plan

**Phase A — P0 bug fixes (host-side, small):**
1. Honor `grant:"command"`: per-session bash-command standing set (exact
   canonicalized command; refuse wildcards like automation does).
2. Make grants outlive the turn: hoist `sessionGranted` (+ new command grants)
   to a per-sessionId store in pi-agent.ts, passed into each mount.
3. Fix doom-loop ordering: count signatures BEFORE the approval classifier
   claims the waterfall (mount order / call next() from the classifier after
   classification so downstream guards see the call).
4. Verify sessionId in respond handlers before resolving (kill G4).

**Phase B — resilience:**
5. Reload/replay: keep pending asks in a resumable registry; re-broadcast
   `tool-confirm-required` on `webContents` reload + on `is-running` upgrade
   (return pending asks, not just a boolean). Template: apiproxy rpcId frames.
6. Optional idle timeout (fail-closed deny w/ notice) + sweep maps on
   destroy/clear; remove lingering abort listeners on settle.

**Phase C — native alignment (with plugin-shaped future):**
7. Adopt dsh-sandbox-policy (workspace-write default) + permission-presets;
   replace the autoApprove boolean with the native policy fold surfaced via a
   Settings preset selector; keep APPROVAL_SAFE as the per-tool layer.
8. Unify the taxonomy: one shared module (tool-risk) consumed by BOTH main
   classifier and renderer; delete drift.
9. Unify the three bridges behind one approval module with pluggable
   transports (interactive IPC / headless map / future ctx.cairn.confirm() for
   user-space plugins — the doom-loop pilot then reuses it).

Phase A items 1–4 are mechanical and testable; recommend starting there.
