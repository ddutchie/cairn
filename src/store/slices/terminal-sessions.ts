/**
 * Terminal Sessions slice.
 *
 * Tracks ephemeral agent terminal sessions within the Agent view.
 * Sessions are never persisted to SQLite — they live for the app lifetime.
 * TerminalManager (renderer singleton) holds the actual xterm.js instances,
 * keyed by sessionId.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PiSubagentMessage {
  /** Unique child session ID */
  childSessionId: string;
  /** Messages streamed by the subagent */
  messages: PiAgentMessage[];
  /** Whether the subagent is still running */
  running: boolean;
  /** Final result returned to the parent */
  result?: string;
  /** Latest token usage from the subagent's LLM steps */
  lastUsage?: { promptTokens: number; completionTokens: number };
}

export interface PiAgentMessage {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  /** Tool calls that occurred before or during this assistant message */
  toolCalls?: {
    /** Unique key to allow in-place updates (tool name + start timestamp) */
    callId: string;
    name: string;
    label: string;
    /** true while the tool is executing, false once done */
    running: boolean;
    ok: boolean;
    output?: string;
    /** Parsed reference for Cairn write tools — renders a linked bubble instead of raw output */
    cairnRef?: { type: "note" | "task"; id: string; title: string };
  }[];
  /** Subagents spawned during this message */
  subagents?: PiSubagentMessage[];
  isStreaming?: boolean;
  timestamp: string;
}

export interface TerminalSession {
  sessionId: string;
  taskId: string;
  taskTitle: string;
  agentId: string;
  agentName: string;
  projectId: string;
  cwd?: string;
  status: "running" | "exited";
  exitCode: number | null;
  spawnedAt: string; // ISO string (JSON-safe)
  /** "pty" = external PTY agent (xterm); "pi" = Cairn native agent (chat UI) */
  sessionType: "pty" | "pi";
  /** Message history for pi sessions — not used by pty sessions */
  piMessages?: PiAgentMessage[];
  /** Prompt to send automatically when PiAgentPane first mounts */
  initialPrompt?: string;
  /** Latest token usage from the LLM — updated after each step */
  lastUsage?: { promptTokens: number; completionTokens: number };
  /** Plan mode: "plan" = conversational planning only; "execute" = full agent (default) */
  mode?: "plan" | "execute";
  /** Note ID of the PRD produced during plan mode — set once agent calls ensure_note */
  planNoteId?: string;
}

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
  markSessionExited: (sessionId: string, exitCode: number) => void;
  /** Add a message to a pi session's message list */
  addPiMessage: (sessionId: string, msg: PiAgentMessage) => void;
  /** Append a token delta to the last streaming assistant message */
  appendPiToken: (sessionId: string, delta: string) => void;
  /** Finalise the streaming assistant message (isStreaming → false) */
  finalisePiMessage: (sessionId: string) => void;
  /** Ensure a streaming assistant message exists — creates one if the last message is not streaming */
  ensurePiStreamingMessage: (sessionId: string) => void;
  /** Append a tool call record to the last assistant message */
  addPiToolCall: (sessionId: string, toolCall: { callId: string; name: string; label: string; running: boolean; ok: boolean; output?: string; cairnRef?: { type: "note" | "task"; id: string; title: string } }) => void;
  /** Update an existing tool call chip in-place (start → done) */
  updatePiToolCall: (sessionId: string, callId: string, patch: { label?: string; running: boolean; ok: boolean; output?: string; cairnRef?: { type: "note" | "task"; id: string; title: string } }) => void;
  /** Clear message history for a pi session */
  clearPiMessages: (sessionId: string) => void;
  /** Update token usage for a session after a step completes */
  updatePiUsage: (sessionId: string, promptTokens: number, completionTokens: number) => void;
  /** Register a new subagent on the last streaming assistant message */
  addPiSubagent: (sessionId: string, childSessionId: string) => void;
  /** Append a token to a subagent's last streaming message */
  appendPiSubagentToken: (sessionId: string, childSessionId: string, delta: string) => void;
  /** Finalise the last streaming message in a subagent */
  finalisePiSubagentMessage: (sessionId: string, childSessionId: string) => void;
  /** Add a tool call to a subagent's last streaming message */
  addPiSubagentToolCall: (sessionId: string, childSessionId: string, toolCall: { callId: string; name: string; label: string; running: boolean; ok: boolean; output?: string; cairnRef?: { type: "note" | "task"; id: string; title: string } }) => void;
  /** Update an existing tool call chip on a subagent message in-place */
  updatePiSubagentToolCall: (sessionId: string, childSessionId: string, callId: string, patch: { label?: string; running: boolean; ok: boolean; output?: string; cairnRef?: { type: "note" | "task"; id: string; title: string } }) => void;
  /** Mark a subagent as done and store its result */
  completePiSubagent: (sessionId: string, childSessionId: string, result: string) => void;
  /** Update token usage on an inline subagent block */
  updatePiSubagentUsage: (sessionId: string, childSessionId: string, promptTokens: number, completionTokens: number) => void;
  /** Start a new step in a subagent (finalise current message) */
  stepPiSubagent: (sessionId: string, childSessionId: string) => void;
  /** Set the mode for a pi session and optionally record the plan note ID */
  setPiMode: (sessionId: string, mode: "plan" | "execute", planNoteId?: string) => void;
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
  _get
) => ({
  terminalSessions: [],
  activeSessionId: null,
  openEditorFiles: [],
  activeEditorFile: null,

  addTerminalSession(session) {
    set((s) => ({
      terminalSessions: [...s.terminalSessions, session],
      activeSessionId: session.sessionId,
    }));
  },

  removeTerminalSession(sessionId) {
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
              { ...last, content: last.content + delta },
            ],
          };
        }
        // No streaming message yet — create one
        return {
          ...t,
          piMessages: [
            ...msgs,
            {
              id: `stream-${Date.now()}`,
              role: "assistant" as const,
              content: delta,
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
        if (!last.content && !(last.toolCalls?.length) && !(last.subagents?.length)) {
          return { ...t, piMessages: msgs.slice(0, -1) };
        }
        return {
          ...t,
          piMessages: [...msgs.slice(0, -1), { ...last, isStreaming: false }],
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
              id: `stream-${Date.now()}`,
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

  addPiToolCall(sessionId, toolCall: { callId: string; name: string; label: string; running: boolean; ok: boolean; output?: string; cairnRef?: { type: "note" | "task"; id: string; title: string } }) {
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
              {
                ...last,
                toolCalls: [...(last.toolCalls ?? []), toolCall],
              },
            ],
          };
        }
        return t;
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
            updated[idx] = { ...updated[idx], ...patch };
            return { ...msg, toolCalls: updated };
          }),
        };
      }),
    }));
  },

  clearPiMessages(sessionId) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) =>
        t.sessionId === sessionId ? { ...t, piMessages: [] } : t
      ),
    }));
  },

  updatePiUsage(sessionId, promptTokens, completionTokens) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) =>
        t.sessionId === sessionId
          ? { ...t, lastUsage: { promptTokens, completionTokens } }
          : t
      ),
    }));
  },

  // ── Subagent helpers ──────────────────────────────────────────────────────

  addPiSubagent(sessionId, childSessionId) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        const msgs = t.piMessages ?? [];
        const last = msgs[msgs.length - 1];
        if (!last?.isStreaming) return t;
        const newSubagent: PiSubagentMessage = { childSessionId, messages: [], running: true };
        return {
          ...t,
          piMessages: [
            ...msgs.slice(0, -1),
            { ...last, subagents: [...(last.subagents ?? []), newSubagent] },
          ],
        };
      }),
    }));
  },

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
                id: `sub-stream-${Date.now()}`,
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
            if (!last?.isStreaming) return msg;
            const newSubagents = [...msg.subagents!];
            newSubagents[subIdx] = {
              ...sub,
              messages: [
                ...subMsgs.slice(0, -1),
                { ...last, toolCalls: [...(last.toolCalls ?? []), toolCall] },
              ],
            };
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
                updated[idx] = { ...updated[idx], ...patch };
                return { ...m, toolCalls: updated };
              }),
            };
            return { ...msg, subagents: newSubagents };
          }),
        };
      }),
    }));
  },

  completePiSubagent(sessionId, childSessionId, result) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        return {
          ...t,
          piMessages: (t.piMessages ?? []).map((msg) => {
            const subIdx = (msg.subagents ?? []).findIndex((sa) => sa.childSessionId === childSessionId);
            if (subIdx === -1) return msg;
            const newSubagents = [...msg.subagents!];
            newSubagents[subIdx] = { ...newSubagents[subIdx], running: false, result };
            return { ...msg, subagents: newSubagents };
          }),
        };
      }),
    }));
  },

  updatePiSubagentUsage(sessionId, childSessionId, promptTokens, completionTokens) {
    set((s) => ({
      terminalSessions: s.terminalSessions.map((t) => {
        if (t.sessionId !== sessionId) return t;
        return {
          ...t,
          piMessages: (t.piMessages ?? []).map((msg) => {
            const subIdx = (msg.subagents ?? []).findIndex((sa) => sa.childSessionId === childSessionId);
            if (subIdx === -1) return msg;
            const newSubagents = [...msg.subagents!];
            newSubagents[subIdx] = { ...newSubagents[subIdx], lastUsage: { promptTokens, completionTokens } };
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
