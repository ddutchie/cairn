/**
 * Typed client for Cairn native agent sessions (`session:*`, `subagent:*`,
 * `approval-grants:*`, `db:session:*`). Every failure rejects with the
 * main-process message; off-Electron calls reject with `IpcUnavailableError`.
 *
 * `prompt` / `abort` / `clear` / `destroy` / `compactNow` / `approvePlan` /
 * `respondQuestions` / `respondTool` / `restoreContext` / `setMode` are
 * fire-and-forget sends — they resolve when the message is queued.
 */
import type { SessionEventEnvelope } from "../../../shared/agent/session-event";
import type { SessionProjection } from "../../../shared/agent/session-projection";
import type { CodingSessionCreateInput } from "../../../shared/agent/session-wire";
import { domainCall, type ElectronApi } from "./client";

type SessionApi = NonNullable<ElectronApi["session"]>;
const session = <T>(fn: (api: SessionApi) => Promise<T>) => domainCall("session", fn);
const send = (fn: (api: SessionApi) => void): Promise<void> =>
  domainCall("session", (api) => { fn(api); return Promise.resolve(); });

export const sessionClient = {
  /** Send a prompt to an existing or new session. Fire-and-forget. */
  prompt: (req: unknown) => send((s) => s.prompt(req)),
  /** Canonical raw engine session/event stream shared by Chat and Coding. */
  onEvent: (cb: (e: SessionEventEnvelope) => void): (() => void) =>
    window.electron?.session?.onEvent?.(cb) ?? (() => {}),
  /** Reasoning-provenance snapshot for the agent panel's Context Ring badge. */
  contextRing: (sessionId: string) => session((s) => s.contextRing(sessionId)),
  isRunning: (sessionId: string) => session((s) => s.isRunning(sessionId)),
  /** Bulk snapshot of session ids whose loop is in flight right now. */
  runningIds: () => session((s) => s.runningIds()),
  /** Abort the current in-flight turn for this session. */
  abort: (sessionId: string) => send((s) => s.abort(sessionId)),
  /** Tell the main process this window started or stopped showing a session (approval notices skip shown ones). */
  setOnScreen: (sessionId: string, onScreen: boolean) => send((s) => s.setOnScreen(sessionId, onScreen)),
  /** Clear message history for a session (start fresh). */
  clear: (sessionId: string) => send((s) => s.clear(sessionId)),
  /** Destroy a session when the tab is closed. */
  destroy: (sessionId: string) => send((s) => s.destroy(sessionId)),
  /** Trigger immediate LLM-based compaction on demand (/compact command). */
  compactNow: (req: unknown) => send((s) => s.compactNow(req)),

  onProjection: (cb: (projection: SessionProjection) => void): (() => void) =>
    window.electron?.session?.onProjection?.(cb) ?? (() => {}),
  /** Latest folded session title (chat-only). Null before first eligible title. */
  title: (threadId: string) => session((s) => s.title(threadId)),
  /** Pin a manual title (kind:'user' — stops auto-titling). Chat-only. */
  renameTitle: (threadId: string, title: string) => session((s) => s.renameTitle(threadId, title)),
  /** Approve the plan — switches session to execute mode and starts implementation. */
  approvePlan: (req: unknown) => send((s) => s.approvePlan(req)),
  /** Answer a blocked ask_questions call — the text is fed back to the model as the tool result. */
  respondQuestions: (sessionId: string, callId: string, answers: string, nonce?: string) =>
    send((s) => s.respondQuestions(sessionId, callId, answers, nonce)),
  /** List all persisted coding sessions for a project (project-scoped history). */
  listSessions: (projectId: string) => session((s) => s.listSessions(projectId)),
  /** Persist a new coding session row to SQLite. */
  createSession: (input: CodingSessionCreateInput) => session((s) => s.createSession(input)),
  /** Delete a coding session and all its messages from SQLite. */
  deleteSession: (id: string) => session((s) => s.deleteSession(id)),
  /** Start engine session `to` as a copy of `from`'s conversation. */
  forkSession: (from: string, to: string, cwd?: string) => session((s) => s.forkSession(from, to, cwd)),
  /** Fetch session transcript from the engine JSONL log, SQLite fallback. */
  getSessionMessages: (sessionId: string) => session((s) => s.getSessionMessages(sessionId)),
  /** Fetch the persisted todo list for a session. */
  getTodos: (sessionId: string) => session((s) => s.getTodos(sessionId)),
  /** Restore LLM context for a session — fire-and-forget. */
  restoreContext: (sessionId: string) => send((s) => s.restoreContext(sessionId)),
  /** Dynamically switch a session's mode. */
  setMode: (sessionId: string, mode: "plan" | "execute") => send((s) => s.setMode(sessionId, mode)),
  /** Approve or deny a pending tool call. */
  respondTool: (
    sessionId: string,
    callId: string,
    approved: boolean,
    grant?: "session" | "command" | "workspace",
    command?: string,
    nonce?: string,
  ) => send((s) => s.respondTool(sessionId, callId, approved, grant, command, nonce)),
  /** Continuable-child catalog for a parent session. */
  listSubagents: (parentSessionId: string, scope?: "children" | "descendants") =>
    session((s) => s.listSubagents(parentSessionId, scope)),
  /** Stop a live continuable child's current turn. */
  interruptSubagent: (parentSessionId: string, childId: string) =>
    session((s) => s.interruptSubagent(parentSessionId, childId)),
  /** Deliver a human message to a continuable child. */
  messageSubagent: (parentSessionId: string, childId: string, text: string) =>
    session((s) => s.messageSubagent(parentSessionId, childId, text)),
  /** Kill an engine background job. */
  killJob: (jobId: string, sessionId: string) => session((s) => s.killJob(jobId, sessionId)),
  /** Current same-session goal snapshot (null when no goal). */
  goal: (sessionId: string) => session((s) => s.goal(sessionId)),
  /** Current permission-preset select. */
  permissions: (sessionId: string) => session((s) => s.permissions(sessionId)),
  setPermissionPreset: (sessionId: string, preset: string) =>
    session((s) => s.setPermissionPreset(sessionId, preset)),
  /** Active session-local reminders. */
  scheduleList: (sessionId: string) => session((s) => s.scheduleList(sessionId)),
  /** Workspace-persistent "Always allow" grants. */
  listApprovalGrants: (workspaceId: string) => session((s) => s.listApprovalGrants(workspaceId)),
  deleteApprovalGrant: (id: string) => session((s) => s.deleteApprovalGrant(id)),
  clearApprovalGrants: (workspaceId: string) => session((s) => s.clearApprovalGrants(workspaceId)),
};
