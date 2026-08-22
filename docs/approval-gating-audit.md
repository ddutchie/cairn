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

**Phase A — P0 bug fixes — ✅ DONE (2026-08-21):**
1. ~~Honor `grant:"command"`~~ — the renderer now echoes the exact bash command
   with the respond event (`pi-agent:respond-tool …command`); the handler
   canonicalizes (trim + whitespace-collapse) and records it in the new
   per-session grant store. Exact-match only; no wildcards.
2. ~~Grants outlive the turn~~ — grants moved from the per-mount
   `sessionGranted` Set to `electron/cordis/approval-grants.ts`
   (`getSessionGrants(sessionId)`), keyed by session and cleared on
   pi-agent:clear/destroy. Covered by remount regression test.
3. ~~Doom-loop ordering~~ — doom-loop mounts BEFORE the approval plugin in
   run-cordis-coding.ts (waterfall listeners fire in registration order, so the
   classifier can no longer hide calls from the guard). Regression test mounts
   both on a chained fake ctx and asserts the doom pause fires on call 3.
4. ~~sessionId verification~~ — all three pending maps are keyed
   `${sessionId}::${callId}`; respond handlers compose the same key. A stale or
   cross-session respond can no longer resolve someone else's ask.
Plus: clear/destroy sweep pending maps + grants.

**Phase B — resilience — ✅ DONE (2026-08-21):**
5. ~~Reload recovery~~ — outstanding asks are recorded in a pending-ask
   registry (`createPendingAskRegistry`) via a send-wrapper on the coding
   loop; `pi-agent:is-running` now returns `{ running, pendingAsks }`, and
   AgentChatPane's busy-sync re-flags the matching chips after a reload
   (transcript restore happens before pane mount, so no clobber race). The
   pull-based design replaces the apiproxy push/replay template — same
   outcome, less machinery.
6. ~~Fail-closed timeouts~~ — every interactive HITL seam now has a
   fail-closed budget (`APPROVAL_TIMEOUT_MS`, 10 min, matching the old
   automation inbox): approvals settle `cancelled` + emit
   `pi-agent:tool-confirm-expired` (renderer retires the card); doom-loop
   denies with an explicit "no response within the time limit" reason;
   question forms settle cancelled. Answered-before-timeout still records
   grants normally (tested). Plus single-settle guards so abort listeners
   never linger after a normal resolution, and registry residue is swept at
   turn end / clear / destroy.

**Phase C — native alignment (with plugin-shaped future):**
7. ~~Unify the taxonomy~~ — ✅ DONE (2026-08-21): `shared/agent/tool-risk.ts`
   is now the single source consumed by BOTH the main-process classifier
   (`APPROVAL_SAFE_TOOLS`/`needsApproval`) and the renderer's approval card
   (`src/lib/tool-risk.ts` is a re-export facade). Drift fixed with it:
   `str_replace_editor`/`todo_write` labelled session-grantable writes;
   Cairn `delete_note`/`delete_task` etc. no longer shown as reads; unknown
   tools default to a conservative WRITE_LOCAL label while the classifier
   keeps default-ask. Regression-tested from both sides.
8. Native policy folds — **PARTIALLY DONE (2026-08-21)**:
   - The coding loop now folds autoApprove into dsh's durable per-session
     `approval/policy` (`setPolicy(agent, autoApprove ? "never" : "ask")` in
     run-cordis-coding.ts) — the jsonl audit trail and the model-visible
     approval section finally reflect reality instead of the pinned "ask"
     default; unchanged across turns is a no-op, resumed sessions fold their
     own history.
   - `dsh-sandbox-policy` confirmed ALREADY mounted natively (workspace-write
     default, workspaceRoot = project cwd) inside plugFsChain — the audit's
     "hard-default danger-full-access" note referred to mountCodingStack's
     shadowed internal default.
   - `dsh-permission-presets` DEFERRED to the next dsh bump: it injects
     ["shell","approval","sessions"] and we register the session service as
     "session"; forcing aliases isn't worth it while presets remains a UX
     layer over two knobs we already set natively.
9. ~~`ctx.cairn.confirm()` seam~~ — ✅ CORE DONE (2026-08-21):
   `electron/cordis/approval-transports.ts` defines the session-scoped
   transport registry + an interactive transport that rides the NATIVE
   approval surface end-to-end (synthetic pending chip → ApprovalCard with
   risk labels/grants from the shared taxonomy → `pi-agent:respond-tool`
   pairing, incl. standing-grant recording and the fail-closed timeout).
   `ctx.cairn.confirm(sessionId, req)` is exposed on the plugin contract in
   getContext — resolves "cancelled" when no session is bound (never
   throws); a pre-aborted ask surfaces nothing at all. Zero new IPC channels:
   plugin asks reuse the existing card pipeline, so the renderer needed no
   changes. Per-turn binding lives beside the approvals adapter in
   pi-agent.ts; cleared on turn end / clear / destroy.
   REMAINING for full consolidation: extract cairnDoomLoopPlugin as the first
   bundled-plugin consumer of this seam (pilot), then fold the headless
   automation bridge onto the same registry.

Phase A items 1–4 are mechanical and testable; recommend starting there.
