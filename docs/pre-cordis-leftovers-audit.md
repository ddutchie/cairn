# Pre-Cordis Leftovers Audit & Cleanup Plan

Audit of everything the pre-Cordis engines left behind, now that Cordis/dsh is
the **only** engine (all turn loops route through `runCordisLoop` /
`runCordisCodingLoop`; verified unconditional). Companion to
`architecture-cordis.md`. Findings gathered by parallel code audits; every item
has file:line evidence.

**Verdict legend**: 🟢 ALIVE (load-bearing) · 🟡 PARTIAL (some exports dead) · 🔴 DEAD (remove) · ⏳ DEFER (needs its own decision/change)

---

## 1. Legacy engine libraries (`electron/lib`)

| File | Lines | Verdict | Notes |
|---|---|---|---|
| `llm.ts` | 681 | 🟢 | Feeds every Cordis runner (`resolveAIConfig`, transports). 🔴 inside it: `streamCompletion` (:418, zero callers), `postChatCompletions`/`LlmCallOpts` (internal-only → un-export). |
| `llm-stream.ts` | 518 | 🟡 | Alive: `consumeAssistantStream`, `buildChatCompletionsBody`, types. 🔴 7 test-only exports: `prepareContextMessages`, `supportsDeveloperRole`, `truncationRetryNotice`, `failToolCallsFromTruncatedMessage`, `truncatedToolCallError`, `interruptedStreamToolCallError`, `AUTO_OUTPUT_TOKEN_CAP` re-export. |
| `responses.ts` | 219 | 🟢 | Wire protocol for every Cordis runner. 🟡 desktop-unused re-exports of `shared/chat/responses` (mobile uses directly). |
| `sse.ts` | 53 | 🟢 | Load-bearing (both transports). |
| `tool-builder.ts` / `tool-builder-prompt.ts` | 458/130 | 🟢 | Registered Tool Builder feature (own mini tool-loop — deliberate, not a leftover). |
| `tool-schemas.ts` | 588 | 🟢 | Cordis tools bridge + mcp-server + renderer MCP settings. |
| `tool-trace.ts` | 37 | 🟢 | Single consumer (`mcp/tools/notes.ts`) — fine, note only. |
| `parse-tool-args.ts` | 10 | 🟢 | Shim re-export; could fold into direct shared import (cosmetic). |
| `truncation.ts` | 128 | 🟡 | Only `DEFAULT_MAX_BYTES` alive; 🔴 `truncateOutput`/`TruncationResult` (bash.ts truncates locally). |
| `chat-executor.ts` (in `ipc/`) | 360 | 🟢 | **Is** the Cordis engine's Cairn-tool dispatcher (`cairn-tools.ts:15`). Mislocated under `ipc/` — candidate to move under `cordis/`. |
| `mobile-tools-fixture.ts` | ~50 | 🟡 | Test-only importer; keep as test helper or move to test dir. |
| `bench-endpoint.ts` | ~50 | 🟢 | Live-test convention helper (used by opt-in live tests). |

**Engine truth**: `runToolLoop` no longer exists anywhere — `chat-loop.ts`,
`pi-agent-loop.ts`, `chat-subagent-loop.ts` were deleted earlier. It survives
only in **stale comments**: `run-cordis-loop.ts:5,542`, `heartbeat-runner.ts:8,203`,
`user-style-handlers.ts:225,246`, `llm-stream.ts:4`, `responses.ts:21`.

---

## 2. IPC channels & pi-agent surface

### SAFE TO REMOVE (zero renderer usage, traced through preload)
1. **`pi-agent:subagent` event wiring** — emitted by nothing (subagents emit
   `chat:subagent*` via cairn-plugins.ts:220–285). Preload :1097–1102 +
   `AgentChatPane.tsx:416`.
2. **`db:chat:addMessage`** handler + `q.addChatMessage` (queries.ts:1048) +
   preload `chat.addMessage` (:391). No writers of transcripts remain.
3. **Session persistence message writes** and their former query helpers
   (queries.ts:1702–1735) + preload `piAgent.saveMessages`.
4. **`db:session:messages`** + preload session message loading — keep
    the session message fallback itself.
5. **`NOTE_WRITE_TOOLS`** const (session-runtime-handlers.ts:69) — unreferenced.
6. **Unused `callLLM` import** (user-style-handlers.ts:13).
7. **Unreachable non-Cordis branch of `runSession`** (session-runtime-handlers.ts:145–154).
8. **Orphaned `session-runtime-types.ts` exports** (`ToolCallSpec`, `ApprovalDecision`,
   dead `AgentMessage` union members) + never-populated `PiAgentSession` fields.
9. **`skillsXml` param + both skill sections** in `coding-session-prompt.ts`
   (:16–20, :77–79, :159–161) — superseded by dsh-tool-skill.

### KEEP (load-bearing — do not touch)
- All 12 registered `pi-agent:*` handlers; `loopSend` bridge + delta batchers.
- `buildPiAgentSystemPrompt` + persona builders (every coding prompt/approve turn).
- `chat.ts` in full; `chat-executor.ts`; `user-style-handlers.ts` in full
  (Cordis-only via one-shot/runCordisLoop).
- Startup purges (`DELETE FROM chat_messages/pi_agent_messages`) and the SQLite
  **fallbacks** inside `db:chat:messages` / `db:session:messages`
  (renderer still calls both channels).

### ⏳ Deferred (needs product decision)
- `reasoningField`/`reasoningModel` plumbing touches types + db-mappers +
  queries columns — settle the usage-gauge question first.
- Schema-level drops (`pi_agent_llm_history`, message-table bodies) only after
  the fallbacks are retired.
- `confirmAction`/`PendingAction` in the chat store (written, never consumed).

---

## 3. Plugin-migration assessment (cairn-* → plugin-shaped)

| Candidate | Privileged needs | Verdict |
|---|---|---|
| `cairnDbPlugin` | DB handle | Keep core — it IS the privilege boundary. |
| `cairnSessionPlugin` / `cairnSystemPromptPlugin` | host-computed per-turn config | Already plugin-shaped; keep core. |
| `cairnQuestionsPlugin` / approval half of `cairnApprovalPlugin` | main-process send + pending resolvers bound to renderer IPC | Keep core (ungrantable to user-space plugins). |
| `cairnSubagentPlugin` / `cairnCodingPlugin` | IPC vocabulary adapters over `event.sender` | Relocation without simplification; keep core. |
| `registerExternalCairnTools` (MCP/custom services) | keychain secrets/OAuth beneath | Keep core. |
| **Doom-loop guard** (`cairnDoomLoopPlugin`) | needs a user-confirm transport only | **Best bundled-plugin pilot** once `ctx.cairn.confirm()` exists. |
| **Skills seam** | none beyond registry access | Expose `ctx.cairn.skills.registerProvider` so community backends ship skills without touching core. |

Sequencing: expose `ctx.cairn.confirm()` + `ctx.cairn.skills` first; extract
doom-loop as the pilot; reuse the confirm transport for approval-policy later.

---

## 4. Execution plan

**Phase 1 — mechanical removal — ✅ DONE (2026-08-21, −830 lines across 18 files):**
items §2.1–§2.9 above, the 🔴 exports in §1 (`streamCompletion`, 7×
llm-stream, `truncateOutput`, un-export `postChatCompletions`), the dead
`callLLM` import, and every stale `runToolLoop`/deleted-file comment.
Also removed: the orphaned store actions `addAgentSubagent`/`completeAgentSubagent`
(terminal-sessions.ts) left dead by §2.1.

Corrections made during execution (audit vs reality):
- `supportsDeveloperRole` was NOT deletable — live `resolveSystemRole` calls it
  internally. Un-exported to module-private instead; its direct-call test
  dropped (behaviour still covered via `resolveSystemRole` tests).
- `StreamToolCall`/`StreamUsage` kept — they appear in live
  `consumeAssistantStream`/`StreamedTurn` signatures (audit over-counted them
  as dead types).
- `PiAgentSession.messages` retyped as turn-marker-only
  (`Array<{ role: "user"; content }>`); nothing reads it — the transcript lives
  in the dsh jsonl log.
- llm.ts `LlmCallOpts`/`postChatCompletions` privatized (un-exported), not
  deleted — both are callLLM internals.
- Pre-existing baseline note: `type-check:all` shows 13 errors at HEAD caused
  by `scratch/dsh-repo` confusing module resolution (attachment-store,
  cairn-plugins Context methods, read-tools/notes-files isolatedModules) —
  identical before and after this work; not introduced here.

**Phase 2 — resolved (2026-08-21):**
- Fallback retirement + schema drops — DONE: `chat_messages`,
  `pi_agent_messages`, and `pi_agent_llm_history` are DROPped on boot and all
  read fallbacks removed (`db:chat:messages`, SQLite legs of
  sessionMessages). Pre-Cordis threads/sessions are permanently empty.
- `reasoningField`/`reasoningModel` — KEPT, with a direction: dsh erases the
  provider field name at its adapter boundary but persists full reasoning +
  model attribution (`message.source`, replay envelopes). Surfacing that as a
  dsh projections plugin ("context ring") is captured in the Cairn project
  notes; our plumbing stays until that lands.
- Remaining orphaned store surface: `finaliseAgentSubagentMessage` is still used.
Mechanical items **✅ DONE (2026-08-21)**: `confirmAction` + `PendingAction`
removed from the chat store/types; `chat-executor.ts` relocated to
`electron/cordis/chat-executor.ts`; `parse-tool-args.ts` shim deleted in favour
of direct `shared/chat/parse-tool-args` imports.

**Phase 3 — plugin-shaped future:** `ctx.cairn.{confirm,skills}` seams →
doom-loop pilot → approval-policy extraction. Tracked in
`dsh-native-alignment.md` after commands/skills land there.
