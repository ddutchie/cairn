/**
 * Terminal Sessions slice.
 *
 * Tracks ephemeral agent terminal sessions within the Agent view.
 * Sessions are never persisted to SQLite — they live for the app lifetime.
 * TerminalManager (renderer singleton) holds the actual xterm.js instances,
 * keyed by sessionId.
 */

import { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import { forgetSessionPrompts } from "../../lib/agent-prompt-guard";
import { id } from "../../lib/utils";

// ── Per-session token buffer (perf) ──────────────────────────────────────────
//
// Coalesces rapid SSE token deltas so appendPiToken doesn't fire a Zustand
// set() (and therefore Virtuoso list re-diff) on every network chunk. Main
// already batches to ~20 events/sec via createDeltaBatcher; this second
// stage collapses same-tick deltas into one set() at the end of the current
// microtask, so a long transcript pays at most one full-list re-diff per
// tick even during a burst. The `run` callback is closed over `set` in
// appendPiToken itself; the buffer just owns the tick timing.
const piTokenBuffer = (() => {
  const pending = new Map<string, { delta: string; run: (batched: string) => void }>();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const entries = Array.from(pending.entries());
    pending.clear();
    for (const [, { delta, run }] of entries) run(delta);
  };
  return {
    push(sessionId: string, delta: string, run: (batched: string) => void) {
      const prev = pending.get(sessionId);
      if (prev) prev.delta += delta;
      else pending.set(sessionId, { delta, run });
      if (!scheduled) {
        scheduled = true;
        // queueMicrotask is available in all Electron/renderer targets;
        // rAF would tie us to a browser tick, but streaming can arrive
        // faster than 60Hz on local models — microtask still collapses
        // multi-chunk bursts within the same JS turn.
        queueMicrotask(flush);
      }
    },
  };
})();

import type {
  TokenBreakdown,
  PiAgentMessage,
  PiSubagentMessage,
  TerminalSession,
  CodingSessionSummary,
  PiTodo,
  SessionKind,
  SessionLoadState,
  SessionPresentation,
} from "../../types";

// Re-export for backwards compatibility (consumers may import from either location).
export type { PiAgentMessage, PiSubagentMessage, TerminalSession, CodingSessionSummary };

// ── Slice ────────────────────────────────────────────────────────────────────

export interface TerminalSessionsSlice {
  terminalSessions: TerminalSession[];
  activeSessionId: string | null;
  /** Ordered list of open file paths in the editor tab strip. */
  openEditorFiles: string[];
  /** Currently active tab — always an element of openEditorFiles, or null. */
  activeEditorFile: string | null;

  addTerminalSession: (session: TerminalSession) => void;
  removeTerminalSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  /** Select one browser session and its presentation as a single intent. */
  openSession: (sessionId: string, kind: SessionKind, presentation?: SessionPresentation) => void;
  sessionLoad: SessionLoadState;
  setSessionLoad: (state: SessionLoadState) => void;
  markSessionExited: (sessionId: string, exitCode: number) => void;
  /** Add a message to a pi session's message list */
  addPiMessage: (sessionId: string, msg: PiAgentMessage) => void;
  /** Append a token delta to the last streaming assistant message */
  appendPiToken: (sessionId: string, delta: string) => void;
  /** Append a reasoning/thinking delta to the last streaming assistant message */
  appendPiThought: (sessionId: string, delta: string) => void;
  /** Finalise the streaming assistant message (isStreaming → false) */
  finalisePiMessage: (sessionId: string) => void;
  /** Ensure a streaming assistant message exists — creates one if the last message is not streaming */
  ensurePiStreamingMessage: (sessionId: string) => void;
  /** Append a tool call record to the last assistant message */
  addPiToolCall: (sessionId: string, toolCall: { callId: string; name: string; label: string; args?: Record<string, unknown>; running: boolean; ok: boolean; output?: string; cairnRef?: { type: "note" | "task"; id: string; title: string } }) => void;
  /** Update an existing tool call chip in-place (start → done) */
  updatePiToolCall: (sessionId: string, callId: string, patch: { label?: string; args?: Record<string, unknown>; running: boolean; ok: boolean; output?: string; cairnRef?: { type: "note" | "task"; id: string; title: string } }) => void;
  /** Set confirmation requirement state for a tool chip */
  setPiToolConfirmRequired: (sessionId: string, callId: string, confirmRequired: boolean, approvalNonce?: string) => void;
  /** Clear message history for a pi session */
  clearPiMessages: (sessionId: string) => void;
  /** Update token usage for a session after a step completes */
  updatePiUsage: (sessionId: string, promptTokens: number, completionTokens: number, reasoningTokens: number, breakdown?: TokenBreakdown, cacheReadTokens?: number, cacheCreationTokens?: number) => void;
  /** Append a token to a subagent's last streaming message */
  appendPiSubagentToken: (sessionId: string, childSessionId: string, delta: string) => void;
  /** Append a reasoning/thought delta to a subagent's last streaming message */
  appendPiSubagentThought: (sessionId: string, childSessionId: string, delta: string) => void;
  /** Finalise the last streaming message in a subagent */
  finalisePiSubagentMessage: (sessionId: string, childSessionId: string) => void;
  /** Add a tool call to a subagent's last streaming message */
  addPiSubagentToolCall: (sessionId: string, childSessionId: string, toolCall: { callId: string; name: string; label: string; args?: Record<string, unknown>; running: boolean; ok: boolean; output?: string; cairnRef?: { type: "note" | "task"; id: string; title: string } }) => void;
  /** Update an existing tool call chip on a subagent message in-place */
  updatePiSubagentToolCall: (sessionId: string, childSessionId: string, callId: string, patch: { label?: string; args?: Record<string, unknown>; running: boolean; ok: boolean; output?: string; cairnRef?: { type: "note" | "task"; id: string; title: string } }) => void;
  /** Update token usage on an inline subagent block */
  updatePiSubagentUsage: (sessionId: string, childSessionId: string, promptTokens: number, completionTokens: number, reasoningTokens: number, breakdown?: TokenBreakdown, cacheReadTokens?: number, cacheCreationTokens?: number) => void;
  /** Start a new step in a subagent (finalise current message) */
  stepPiSubagent: (sessionId: string, childSessionId: string) => void;
  /** Set the mode for a pi session and optionally record the plan note ID */
  setPiMode: (sessionId: string, mode: "plan" | "execute", planNoteId?: string) => void;
  /** Record the explicit auto-approval choice for the session lifetime. */
  setPiAutoApprove: (sessionId: string, autoApprove: boolean) => void;
  /** ID of the session currently shown in the persistent Cairn Agent pinned tab */
  activeCodingSessionId: string | null;
  /** Project-scoped history of persisted coding sessions (from SQLite) */
  codingSessionHistory: CodingSessionSummary[];
  /** Per-session todo lists (todowrite tool) keyed by session id. */
  piSessionTodos: Record<string, PiTodo[]>;
  /** Set the persistent pi session (switches what the pinned tab shows) */
  setActiveCodingSession: (sessionId: string | null) => void;
  /** Replace a session's todo list (from pi-agent:todos events / load). */
  setPiSessionTodos: (sessionId: string, todos: PiTodo[]) => void;
  /** Fetch session history from SQLite for the given project */
  fetchCodingSessionHistory: (projectId: string) => Promise<void>;
  /** Fetch and merge session history for the projects visible in the sidebar. */
  fetchCodingSessionHistoryForProjects: (projectIds: string[]) => Promise<void>;
  /** Remove a session from history (also calls the IPC delete) */
  deleteCodingSessionFromHistory: (sessionId: string) => Promise<void>;
  /** Add or update a session in the local history list (optimistic) */
  upsertCodingSessionSummary: (summary: CodingSessionSummary) => void;
  /** Open a file tab (no-op if already open) and make it active. */
  openEditorFile: (path: string) => void;
  /** Close a file tab; activates the nearest remaining tab. */
  closeEditorFile: (path: string) => void;
  /** @deprecated use openEditorFile */
  setActiveEditorFile: (path: string | null) => void;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createTerminalSessionsSlice: StateCreator<CairnStore, [], [], TerminalSessionsSlice> = (
  set,
  get
) => ({
  terminalSessions: [],
  activeSessionId: null,
  openEditorFiles: [],
  activeEditorFile: null,
  activeCodingSessionId: null,
  codingSessionHistory: [],
  piSessionTodos: {},
  sessionLoad: { status: "idle" },

  addTerminalSession(session) {
    set((s) => ({
      terminalSessions: [...s.terminalSessions, session],
      activeSessionId: session.sessionId,
    }));
  },

  removeTerminalSession(sessionId) {
    forgetSessionPrompts(sessionId);
    set((s) => {
      const remaining = s.terminalSessions.filter((t) => t.sessionId !== sessionId);
      const nextActive =
        s.activeSessionId === sessionId
          ? (remaining[remaining.length - 1]?.sessionId ?? null)
          : s.activeSessionId;
      return { terminalSessions: remaining, activeSessionId: nextActive };
    });
  },

  setActiveSession(sessionId) {
    set({ activeSessionId: sessionId });
  },

  openSession(sessionId, kind, presentation = "drawer") {
    if (kind === "chat") {
      get().setActiveChatThreadId(sessionId);
      get().setActiveSession("chat");
    } else {
      get().setActiveSession(sessionId);
    }
    get().setSessionPresentation(presentation);
  },

  setSessionLoad(state) {
    set({ sessionLoad: state });
  },

  markSessionExited(sessionId, exitCode) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) =>
        t.sessionId === sessionId ? { ...t, status: "exited", exitCode } : t
      ),
    }));
  },

  addPiMessage(sessionId, msg) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) =>
        t.sessionId === sessionId
          ? { ...t, piMessages: [...(t.piMessages ?? []), msg] }
          : t
      ),
    }));
  },

  appendPiToken(sessionId, delta) {
    // Coalesce rapid token deltas so we don't fire a Zustand set() (and
    // therefore a Virtuoso list re-diff) once per SSE chunk. The main-
    // process already batches deltas at ~20 events/sec (createDeltaBatcher
    // in electron/ipc/pi-agent.ts), but on a long transcript even 20
    // renders/sec of the whole message array is expensive. Buffer per
    // session across microtasks and flush at the end of the current tick
    // — user-perceived latency stays under one frame, but multiple deltas
    // in the same tick collapse to a single set().
    piTokenBuffer.push(sessionId, delta, (batched) => {
      set((s) => ({
        terminalSessions: s.terminalSessions.map((t) => {
          if (t.sessionId !== sessionId) return t;
          const msgs = t.piMessages ?? [];
          const last = msgs[msgs.length - 1];
          if (last?.isStreaming) {
            return {
              ...t,
              piMessages: [
                ...msgs.slice(0, -1),
                { ...last, content: last.content + batched },
              ],
            };
          }
          // No streaming message yet — create one. Use id() (nanoid) not
          // stream-${Date.now()} to avoid same-ms collisions between the
          // token appender and appendPiThought / ensurePiStreamingMessage.
          return {
            ...t,
            piMessages: [
              ...msgs,
              {
                id: `stream-${id()}`,
                role: "assistant" as const,
                content: batched,
                isStreaming: true,
                timestamp: new Date().toISOString(),
              },
            ],
          };
        }),
      }));
    });
  },

  appendPiThought(sessionId, delta) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        const msgs = t.piMessages ?? [];
        const last = msgs[msgs.length - 1];
        if (last?.isStreaming) {
          return {
            ...t,
            piMessages: [
              ...msgs.slice(0, -1),
              { ...last, reasoning: (last.reasoning ?? "") + delta },
            ],
          };
        }
        return {
          ...t,
          piMessages: [
            ...msgs,
            {
              id: `stream-${id()}`,
              role: "assistant" as const,
              content: "",
              reasoning: delta,
              isStreaming: true,
              timestamp: new Date().toISOString(),
            },
          ],
        };
      }),
    }));
  },

  finalisePiMessage(sessionId) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        const msgs = t.piMessages ?? [];
        const last = msgs[msgs.length - 1];
        if (!last?.isStreaming) return t;
        // Drop empty tool-free messages entirely rather than leaving blank bubbles.
        // This happens when a loop step does only tool calls with no surrounding text.
        // Preserve messages that have reasoning text (reasoning-only turns).
        if (!last.content && !last.reasoning && !(last.toolCalls?.length) && !(last.subagents?.length)) {
          return { ...t, piMessages: msgs.slice(0, -1) };
        }
        // Force any still-running tool chips to done so they never stay as spinners
        // after the step boundary (onStep / onDone fires before onTool end in some cases).
        const finalisedToolCalls = last.toolCalls?.map((tc) =>
          tc.running ? { ...tc, running: false } : tc
        );
        return {
          ...t,
          piMessages: [
            ...msgs.slice(0, -1),
            { ...last, isStreaming: false, toolCalls: finalisedToolCalls },
          ],
        };
      }),
    }));
  },

  ensurePiStreamingMessage(sessionId) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        const msgs = t.piMessages ?? [];
        const last = msgs[msgs.length - 1];
        if (last?.isStreaming) return t; // already have one
        return {
          ...t,
          piMessages: [
            ...msgs,
            {
              id: `stream-${id()}`,
              role: "assistant" as const,
              content: "",
              isStreaming: true,
              timestamp: new Date().toISOString(),
            },
          ],
        };
      }),
    }));
  },

  addPiToolCall(sessionId, toolCall: { callId: string; name: string; label: string; args?: Record<string, unknown>; running: boolean; ok: boolean; output?: string; cairnRef?: { type: "note" | "task"; id: string; title: string } }) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        const msgs = t.piMessages ?? [];
        const last = msgs[msgs.length - 1];
        if (last?.isStreaming) {
          // If a chip with this callId already exists (created by onToolPending),
          // update it in-place rather than appending a duplicate.
          const existing = (last.toolCalls ?? []).findIndex((tc) => tc.callId === toolCall.callId);
          if (existing !== -1) {
            const updated = [...last.toolCalls!];
            updated[existing] = { ...updated[existing], ...toolCall };
            return { ...t, piMessages: [...msgs.slice(0, -1), { ...last, toolCalls: updated }] };
          }
          // Happy path: new chip
          return {
            ...t,
            piMessages: [
              ...msgs.slice(0, -1),
              { ...last, toolCalls: [...(last.toolCalls ?? []), toolCall] },
            ],
          };
        }
        // Race condition fallback: create streaming message and attach chip atomically.
        const newMsg = {
          id: `stream-${id()}`,
          role: "assistant" as const,
          content: "",
          isStreaming: true,
          timestamp: new Date().toISOString(),
          toolCalls: [toolCall],
        };
        return { ...t, piMessages: [...msgs, newMsg] };
      }),
    }));
  },

  updatePiToolCall(sessionId, callId, patch) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        return {
          ...t,
          piMessages: (t.piMessages ?? []).map((msg) => {
            if (!msg.toolCalls) return msg;
            const idx = msg.toolCalls.findIndex((tc) => tc.callId === callId);
            if (idx === -1) return msg;
            const updated = [...msg.toolCalls];
            updated[idx] = { ...updated[idx], ...patch, confirmRequired: false };
            return { ...msg, toolCalls: updated };
          }),
        };
      }),
    }));
  },

  setPiToolConfirmRequired(sessionId, callId, confirmRequired, approvalNonce) {
    // Approval-card patch: attach both the confirm flag and (when supplied)
    // the main-side per-ask nonce so pi-agent:respond-tool can verify the
    // click's provenance. On clear (confirmRequired=false), drop the nonce
    // too — it's a one-shot secret.
    const patch = confirmRequired
      ? { confirmRequired: true, ...(approvalNonce ? { approvalNonce } : {}) }
      : { confirmRequired: false, approvalNonce: undefined };
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        return {
          ...t,
          piMessages: (t.piMessages ?? []).map((msg) => {
            // Top-level chips…
            if (msg.toolCalls) {
              const idx = msg.toolCalls.findIndex((tc) => tc.callId === callId);
              if (idx !== -1) {
                const updated = [...msg.toolCalls];
                updated[idx] = { ...updated[idx], ...patch };
                return { ...msg, toolCalls: updated };
              }
            }
            // …and chips nested inside subagent blocks (audit G12): a confirm
            // whose callId lives in a child transcript must still surface and
            // retire its card.
            if (!msg.subagents?.length) return msg;
            let changed = false;
            const newSubagents = msg.subagents.map((sa) => ({
              ...sa,
              messages: sa.messages.map((m) => {
                if (!m.toolCalls) return m;
                const idx = m.toolCalls.findIndex((tc) => tc.callId === callId);
                if (idx === -1) return m;
                changed = true;
                const updated = [...m.toolCalls];
                updated[idx] = { ...updated[idx], ...patch };
                return { ...m, toolCalls: updated };
              }),
            }));
            return changed ? { ...msg, subagents: newSubagents } : msg;
          }),
        };
      }),
    }));
  },

  clearPiMessages(sessionId) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) =>
        t.sessionId === sessionId ? { ...t, piMessages: [], lastUsage: undefined } : t
      ),
    }));
  },

  setPiSessionTodos(sessionId, todos) {
    set((s) => ({
      piSessionTodos: { ...s.piSessionTodos, [sessionId]: todos },
    }));
  },

  updatePiUsage(sessionId, promptTokens, completionTokens, reasoningTokens, breakdown, cacheReadTokens, cacheCreationTokens) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) =>
        t.sessionId === sessionId
          ? { ...t, lastUsage: { promptTokens, completionTokens, reasoningTokens, breakdown, cacheReadTokens, cacheCreationTokens } }
          : t
      ),
    }));
  },

  // ── Subagent helpers ──────────────────────────────────────────────────────

  appendPiSubagentToken(sessionId, childSessionId, delta) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        return {
          ...t,
          piMessages: (t.piMessages ?? []).map((msg) => {
            const subIdx = (msg.subagents ?? []).findIndex((sa) => sa.childSessionId === childSessionId);
            if (subIdx === -1) return msg;
            const sub = msg.subagents![subIdx];
            const subMsgs = sub.messages;
            const lastSub = subMsgs[subMsgs.length - 1];
            let newSubMsgs: PiAgentMessage[];
            if (lastSub?.isStreaming) {
              newSubMsgs = [...subMsgs.slice(0, -1), { ...lastSub, content: lastSub.content + delta }];
            } else {
              newSubMsgs = [...subMsgs, {
                id: `sub-stream-${id()}`,
                role: "assistant" as const,
                content: delta,
                isStreaming: true,
                timestamp: new Date().toISOString(),
              }];
            }
            const newSubagents = [...msg.subagents!];
            newSubagents[subIdx] = { ...sub, messages: newSubMsgs };
            return { ...msg, subagents: newSubagents };
          }),
        };
      }),
    }));
  },

  appendPiSubagentThought(sessionId, childSessionId, delta) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        return {
          ...t,
          piMessages: (t.piMessages ?? []).map((msg) => {
            const subIdx = (msg.subagents ?? []).findIndex((sa) => sa.childSessionId === childSessionId);
            if (subIdx === -1) return msg;
            const sub = msg.subagents![subIdx];
            const subMsgs = sub.messages;
            const lastSub = subMsgs[subMsgs.length - 1];
            let newSubMsgs: PiAgentMessage[];
            if (lastSub?.isStreaming) {
              newSubMsgs = [...subMsgs.slice(0, -1), { ...lastSub, reasoning: (lastSub.reasoning ?? "") + delta }];
            } else {
              newSubMsgs = [...subMsgs, {
                id: `sub-stream-${id()}`,
                role: "assistant" as const,
                content: "",
                reasoning: delta,
                isStreaming: true,
                timestamp: new Date().toISOString(),
              }];
            }
            const newSubagents = [...msg.subagents!];
            newSubagents[subIdx] = { ...sub, messages: newSubMsgs };
            return { ...msg, subagents: newSubagents };
          }),
        };
      }),
    }));
  },

  finalisePiSubagentMessage(sessionId, childSessionId) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        return {
          ...t,
          piMessages: (t.piMessages ?? []).map((msg) => {
            const subIdx = (msg.subagents ?? []).findIndex((sa) => sa.childSessionId === childSessionId);
            if (subIdx === -1) return msg;
            const sub = msg.subagents![subIdx];
            const subMsgs = sub.messages;
            const last = subMsgs[subMsgs.length - 1];
            if (!last?.isStreaming) return msg;
            const newSubagents = [...msg.subagents!];
            newSubagents[subIdx] = {
              ...sub,
              messages: [...subMsgs.slice(0, -1), { ...last, isStreaming: false }],
            };
            return { ...msg, subagents: newSubagents };
          }),
        };
      }),
    }));
  },

  addPiSubagentToolCall(sessionId, childSessionId, toolCall) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        return {
          ...t,
          piMessages: (t.piMessages ?? []).map((msg) => {
            const subIdx = (msg.subagents ?? []).findIndex((sa) => sa.childSessionId === childSessionId);
            if (subIdx === -1) return msg;
            const sub = msg.subagents![subIdx];
            const subMsgs = sub.messages;
            const last = subMsgs[subMsgs.length - 1];
            const newSubagents = [...msg.subagents!];
            if (last?.isStreaming) {
              // Same dedupe as the parent's addPiToolCall: onToolPending (streaming),
              // onToolStart (execution) and bash onUpdate label updates all fire with
              // the SAME callId. Update the existing chip in place — appending
              // duplicates leaves extra chips permanently "running", because
              // updatePiSubagentToolCall only resolves the first match.
              const existing = (last.toolCalls ?? []).findIndex((tc) => tc.callId === toolCall.callId);
              if (existing !== -1) {
                const updated = [...(last.toolCalls ?? [])];
                updated[existing] = { ...updated[existing], ...toolCall };
                newSubagents[subIdx] = {
                  ...sub,
                  messages: [...subMsgs.slice(0, -1), { ...last, toolCalls: updated }],
                };
              } else {
                newSubagents[subIdx] = {
                  ...sub,
                  messages: [
                    ...subMsgs.slice(0, -1),
                    { ...last, toolCalls: [...(last.toolCalls ?? []), toolCall] },
                  ],
                };
              }
            } else {
              // Same race as parent: create streaming message and attach chip atomically
              const newMsg = {
                id: `stream-${id()}`,
                role: "assistant" as const,
                content: "",
                isStreaming: true,
                timestamp: new Date().toISOString(),
                toolCalls: [toolCall],
              };
              newSubagents[subIdx] = { ...sub, messages: [...subMsgs, newMsg] };
            }
            return { ...msg, subagents: newSubagents };
          }),
        };
      }),
    }));
  },

  updatePiSubagentToolCall(sessionId, childSessionId, callId, patch) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        return {
          ...t,
          piMessages: (t.piMessages ?? []).map((msg) => {
            const subIdx = (msg.subagents ?? []).findIndex((sa) => sa.childSessionId === childSessionId);
            if (subIdx === -1) return msg;
            const sub = msg.subagents![subIdx];
            const newSubagents = [...msg.subagents!];
            newSubagents[subIdx] = {
              ...sub,
              messages: sub.messages.map((m) => {
                if (!m.toolCalls) return m;
                const idx = m.toolCalls.findIndex((tc) => tc.callId === callId);
                if (idx === -1) return m;
                const updated = [...m.toolCalls];
                // Hard-reset confirmRequired like the top-level updatePiToolCall:
                // a tool-end patch retires any open approval card on this chip.
                updated[idx] = { ...updated[idx], ...patch, confirmRequired: false };
                return { ...m, toolCalls: updated };
              }),
            };
            return { ...msg, subagents: newSubagents };
          }),
        };
      }),
    }));
  },

  updatePiSubagentUsage(sessionId, childSessionId, promptTokens, completionTokens, reasoningTokens, breakdown, cacheReadTokens, cacheCreationTokens) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        return {
          ...t,
          piMessages: (t.piMessages ?? []).map((msg) => {
            const subIdx = (msg.subagents ?? []).findIndex((sa) => sa.childSessionId === childSessionId);
            if (subIdx === -1) return msg;
            const newSubagents = [...msg.subagents!];
            newSubagents[subIdx] = { ...newSubagents[subIdx], lastUsage: { promptTokens, completionTokens, reasoningTokens, breakdown, cacheReadTokens, cacheCreationTokens } };
            return { ...msg, subagents: newSubagents };
          }),
        };
      }),
    }));
  },

  stepPiSubagent(sessionId, childSessionId) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        return {
          ...t,
          piMessages: (t.piMessages ?? []).map((msg) => {
            const subIdx = (msg.subagents ?? []).findIndex((sa) => sa.childSessionId === childSessionId);
            if (subIdx === -1) return msg;
            const sub = msg.subagents![subIdx];
            const subMsgs = sub.messages;
            const last = subMsgs[subMsgs.length - 1];
            if (!last?.isStreaming) return msg;
            const newSubagents = [...msg.subagents!];
            newSubagents[subIdx] = {
              ...sub,
              messages: [...subMsgs.slice(0, -1), { ...last, isStreaming: false }],
            };
            return { ...msg, subagents: newSubagents };
          }),
        };
      }),
    }));
  },

  setPiMode(sessionId, mode, planNoteId) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) =>
        t.sessionId === sessionId
          ? { ...t, mode, ...(planNoteId !== undefined ? { planNoteId } : {}) }
          : t
      ),
    }));
  },

  setPiAutoApprove(sessionId, autoApprove) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) =>
        t.sessionId === sessionId ? { ...t, autoApprove } : t
      ),
    }));
  },

  setActiveCodingSession(sessionId) {
    set({ activeCodingSessionId: sessionId });
  },

  async fetchCodingSessionHistory(projectId) {
    if (typeof window === "undefined" || !window.electron) return;
    try {
      const history = await window.electron.piAgent.listSessions(projectId) as CodingSessionSummary[];
      set({ codingSessionHistory: history });
    } catch (err) {
      console.error("[coding-sessions] fetchCodingSessionHistory error", err);
    }
  },

  async fetchCodingSessionHistoryForProjects(projectIds) {
    if (typeof window === "undefined" || !window.electron) return;
    try {
      const histories = await Promise.all(
        projectIds.map(async (projectId) => window.electron!.piAgent.listSessions(projectId) as Promise<CodingSessionSummary[]>),
      );
      const merged = histories.flat().sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      set({ codingSessionHistory: merged });
    } catch (err) {
      console.error("[coding-sessions] project history fetch error", err);
    }
  },

  async deleteCodingSessionFromHistory(sessionId) {
    if (typeof window === "undefined" || !window.electron) return;
    // Optimistic removal
    set((s) => ({
      codingSessionHistory: s.codingSessionHistory.filter((h) => h.id !== sessionId),
      activeCodingSessionId: s.activeCodingSessionId === sessionId ? null : s.activeCodingSessionId,
    }));
    try {
      await window.electron.piAgent.deleteSession(sessionId);
    } catch (err) {
      console.error("[coding-sessions] deleteCodingSessionFromHistory error", err);
    }
  },

  upsertCodingSessionSummary(summary) {
    set((s) => {
      const exists = s.codingSessionHistory.some((h) => h.id === summary.id);
      if (exists) {
        return {
          codingSessionHistory: s.codingSessionHistory.map((h) => h.id === summary.id ? summary : h),
        };
      }
      return {
        codingSessionHistory: [summary, ...s.codingSessionHistory],
      };
    });
  },

  openEditorFile(path) {
    set((s) => ({
      openEditorFiles: s.openEditorFiles.includes(path)
        ? s.openEditorFiles
        : [...s.openEditorFiles, path],
      activeEditorFile: path,
    }));
  },

  closeEditorFile(path) {
    set((s) => {
      const idx = s.openEditorFiles.indexOf(path);
      if (idx === -1) return {};
      const next = s.openEditorFiles.filter((f) => f !== path);
      const nextActive =
        s.activeEditorFile !== path
          ? s.activeEditorFile
          : (next[Math.min(idx, next.length - 1)] ?? null);
      return { openEditorFiles: next, activeEditorFile: nextActive };
    });
  },

  setActiveEditorFile(path) {
    // Legacy: treat as openEditorFile when path given, no-op on null
    if (path) {
      set((s) => ({
        openEditorFiles: s.openEditorFiles.includes(path)
          ? s.openEditorFiles
          : [...s.openEditorFiles, path],
        activeEditorFile: path,
      }));
    }
  },
});
