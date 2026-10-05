/** Cairn native agent sessions (chat + coding). */

import { invokeContract, onIpcEvent, sendContract } from "./ipc";
import type { SessionEventEnvelope } from "../../shared/agent/session-event";
import type { SessionProjection } from "../../shared/agent/session-projection";
import type { CodingSessionCreateInput, PutMessageFeedbackInput } from "../../shared/agent/session-wire";

export const sessionApi = {
  // ── Cairn native agent (pi) ───────────────────
  session: {
    /** Send a prompt to an existing or new session. Fire-and-forget. */
    prompt: (req: unknown) => sendContract("session:prompt", req),
    /** Canonical raw DSH session/event stream shared by Chat and Coding. */
    onEvent: (cb: (e: SessionEventEnvelope) => void) => onIpcEvent("session:event", cb),
    /** Reasoning-provenance snapshot for the agent panel's Context Ring badge */
    contextRing: (sessionId: string) => invokeContract("session:context-ring", { sessionId }),
    isRunning: (sessionId: string) => invokeContract("session:is-running", { sessionId }),
    /** Bulk snapshot of session ids whose loop is in flight right now. */
    runningIds: () => invokeContract("session:running-ids"),
    /** Abort the current in-flight turn for this session. */
    abort: (sessionId: string) => sendContract("session:abort", { sessionId }),
    /** Clear message history for a session (start fresh). */
    clear: (sessionId: string) => sendContract("session:clear", { sessionId }),
    /** Destroy a session when the tab is closed. */
    destroy: (sessionId: string) => sendContract("session:destroy", { sessionId }),
    /** Trigger immediate LLM-based compaction on demand (/compact command). */
    compactNow: (req: unknown) => sendContract("session:compact-now", req),

    onProjection: (cb: (projection: SessionProjection) => void) => onIpcEvent("session:projection", cb),
    /** Latest folded session title (chat-only). Null before first eligible title. */
    title: (threadId: string) => invokeContract("session:title", { threadId }),
    /** Pin a manual title (kind:'user' — stops auto-titling). Chat-only. */
    renameTitle: (threadId: string, title: string) => invokeContract("session:renameTitle", { threadId, title }),
    /** Fired when the agent calls ensure_note in plan mode — carries the PRD note ID */
    /**
     * Fired when the agent produces a plan for user review. Two shapes carry
     * this today:
     *   - dsh-plan-mode's `exit_plan_mode` tool call (planContent is set,
     *     noteId is undefined) — the plan is in the tool call args and dsh's
     *     userQuestions.ask surfaces the review card;
     *   - the legacy PRD-note flow (noteId is set, planContent is undefined)
     *     where the agent calls `ensure_note` while in plan mode.
     * A given session may emit both over its lifetime; the renderer uses
     * whichever fields are populated to update the UI.
     */
    /** Approve the plan — switches session to execute mode and starts implementation */
    approvePlan: (req: unknown) => sendContract("session:approve-plan", req),
    /** Fired when the agent calls ask_questions — renderer should render an inline form */
    /** Answer a blocked ask_questions call — the text is fed back to the model as the tool result */
    respondQuestions: (sessionId: string, callId: string, answers: string, nonce?: string) => sendContract("session:respond-questions", { sessionId, callId, answers, nonce }),
    /** List all persisted coding sessions for a project (project-scoped history) */
    listSessions:   (projectId: string) => invokeContract("db:session:list", { projectId }),
    /** Persist a new coding session row to SQLite */
    createSession:  (input: CodingSessionCreateInput) => invokeContract("db:session:create", input),
    /** Delete a coding session and all its messages from SQLite */
    deleteSession:  (id: string) => invokeContract("db:session:delete", { id }),
    /** Fetch session transcript from the dsh JSONL log (session-as-truth), SQLite fallback */
    getSessionMessages: (sessionId: string) => invokeContract("db:session:messages", { sessionId }),
    /** Fetch the persisted todo list for a session */
    getTodos:       (sessionId: string) => invokeContract("db:session:todos", { sessionId }),
    /** Restore LLM context for a session (loads history into main-process Map) — fire-and-forget */
    restoreContext: (sessionId: string) => sendContract("session:restore-context", { sessionId }),
    /**
     * Dynamically switch a session's mode */
    setMode: (sessionId: string, mode: "plan" | "execute") =>
      sendContract("session:set-mode", { sessionId, mode }),
    /** Approve or deny a pending tool call; grant:"command" echoes the exact bash command to standing-allow */
    respondTool: (sessionId: string, callId: string, approved: boolean, grant?: "session" | "command" | "workspace", command?: string, nonce?: string) =>
      sendContract("session:respond-tool", { sessionId, callId, approved, grant, command, nonce }),
    /** Continuable-child catalog for a parent session (durable + live activity). Scope defaults to direct children; "descendants" lists the full subtree. */
    listSubagents: (parentSessionId: string, scope?: "children" | "descendants") => invokeContract("subagent:list", { parentSessionId, scope: scope ?? "children" }),
    /** Stop a live continuable child's current turn (fire-and-return; absent targets are a no-op) */
    interruptSubagent: (parentSessionId: string, childId: string) => invokeContract("subagent:interrupt", { parentSessionId, childId }),
    /** Deliver a human message to a continuable child (needs the live parent agent; parent-unavailable otherwise) */
    messageSubagent: (parentSessionId: string, childId: string, text: string) => invokeContract("subagent:message", { parentSessionId, childId, text }),
    /** Kill a dsh background job (jobs dock; owner-unavailable when the owner turn ended) */
    killJob: (jobId: string, sessionId: string) => invokeContract("session:job-kill", { jobId, sessionId }),
    /** Current same-session goal snapshot (null when no goal); live changes arrive via onProjection kind:"goal" */
    goal: (sessionId: string) => invokeContract("session:goal", { sessionId }),
    /** Current permission-preset select ({options, currentValue}); live changes arrive via onProjection kind:"permissions". ok:false while the presets service is unavailable (switcher hides) */
    permissions: (sessionId: string) => invokeContract("session:permissions", { sessionId }),
    setPermissionPreset: (sessionId: string, preset: string) => invokeContract("session:permissions:set", { sessionId, preset }),
    /** Rate an assistant message (thumbs + optional note); preserves a stored note unless replaced */
    feedback: (req: PutMessageFeedbackInput) => invokeContract("session:feedback", req),
    /** Current rating for one message (null when unrated) */
    feedbackGet: (sessionId: string, messageId: string) => invokeContract("session:feedback-get", { sessionId, messageId }),
    /** Active session-local reminders (empty when the schedule overlay is off or none) */
    scheduleList: (sessionId: string) => invokeContract("session:schedule-list", { sessionId }),
    /** Workspace-persistent "Always allow" grants */
    listApprovalGrants: (workspaceId: string) => invokeContract("approval-grants:list", { workspaceId }),
    deleteApprovalGrant: (id: string) => invokeContract("approval-grants:delete", { id }),
    clearApprovalGrants: (workspaceId: string) => invokeContract("approval-grants:clear-workspace", { workspaceId }),

  },
} as const;
