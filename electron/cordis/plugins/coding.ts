import { readToolResult } from "../tool-result-message";
import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import "../ctx-augment";
import { type SessionProjectionKind } from "../../../shared/agent/session-projection";
import { getHost } from "./db";
import { sendProjection } from "./shared";

// ── cairn-coding ──────────────────────────────────────────────────────────────
// Bridge the MAIN coding session's dsh events onto Cairn's `session:*` IPC
// vocabulary (historically `pi-agent:*`, now `session:*`) so the renderer's
// AgentChatPane works unchanged over the Cordis engine (Phase 1.5 step 2b).
// Sibling to cairnSubagentPlugin (which handles child `origin:'subagent'`
// sessions); this one owns the parent session's token/thought/tool/usage/
// step/done/error stream plus the note-updated / todos / plan-note side
// effects. It is scoped to a single parent sessionId and ignores subagent
// children (those are bridged by cairnSubagentPlugin).

export interface CairnCodingConfig {
  /** The parent coding session id — scopes every emitted event (the caller's id). */
  sessionId: string;
  /**
   * The dsh session id to MATCH events against (the loop's attempt session id).
   * Separate from `sessionId` because the loop mints a fresh dsh id per attempt.
   */
  matchSessionId: string;
  /** Current agent mode — drives plan-note detection. */
  mode: "plan" | "execute";
  /** Emit a `session:*` IPC event to the renderer (sessionId NOT yet tagged). */
  send: (channel: string, payload: Record<string, unknown>) => void;
  /** Resolve/abort when the parent turn completes — used by the loop await. */
  signal?: AbortSignal;
  /** Forward the raw DSH event without changing or flattening it. */
  onSessionEvent?: (event: SessionEvent) => void;
}

/**
 * Map the parent coding session's `session/event` stream to typed Cairn
 * projections.
 * Mirrors the built-in runSession() wiring in electron/ipc/session-runtime-handlers.ts, but
 * driven entirely from dsh events (the dsh agent loop runs the model↔tools loop
 * internally — we only translate what it emits).
 *
 * The projection kinds mirror the renderer's presentation contract; raw DSH
 * events remain available through the session:event stream.
 *
 * Token/reasoning deltas are streamed live; the final assistant/message only
 * fills gaps (never re-emits streamed content — same guard as cairnSubagentPlugin).
 */
export function cairnCodingPlugin(ctx: Context, config: CairnCodingConfig): void {
  const { sessionId, matchSessionId, mode, send, signal, onSessionEvent } = config;

  // Track per-callId tool names (parallel calls to different tools resolve by callId).
  const callName = new Map<string, string>();
  // Latest compaction summary text, captured on compaction/summary and reported
  // to the renderer on compaction/end (auto-compaction is step-boundary driven).
  let lastCompactSummary = "";
  let lastCompactCount = 0;

  const emit = (kind: SessionProjectionKind, payload: Record<string, unknown>) => sendProjection(send, sessionId, kind, payload);

  void signal;

  ctx.on("session/event", (session: Session, event: SessionEvent) => {
    // Only the parent session (this loop's dsh attempt id) — children are bridged
    // by cairnSubagentPlugin.
    if (String((session as { id?: unknown }).id) !== matchSessionId) return;
    onSessionEvent?.(event);

    // ── Plan-mode flips (dsh-owned) ─────────────────────────────────────────
    // /plan (or planMode.set) commits a log-only plan/mode event; forward it so
    // the renderer's toggle reflects the authoritative session state.
    if (event.type === "plan/mode") {
      const active = (event.data as { active?: boolean } | undefined)?.active === true;
       emit("mode-change", { mode: active ? "plan" : "execute" });
      return;
    }

    // ── Tool call (model's request, before execution) ────────────────────────
    if (event.type === "tool/call") {
      const d = event.data as { name: string; arguments?: string; callId?: string };
      if (d.callId) callName.set(d.callId, d.name);
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(d.arguments ?? "{}") as Record<string, unknown>; } catch { /* keep {} */ }

      // Plan-mode approval capture (dsh-native flow): when the model calls
      // exit_plan_mode, the FULL markdown plan is in args.plan. Persist it
      // eagerly on tool/call — before the user has actually approved — so
      // that if the user reloads mid-review or the app crashes, we can
      // re-present the same plan without losing it. If the user chooses
      // "Keep planning", the model will call exit_plan_mode again with a
      // revised plan, which overwrites this value. If the user Approves,
      // plan/mode flips off and execute-mode's next turn reads this cached
      // plan_content to keep the plan in its system prompt.
      if (d.name === "exit_plan_mode" && typeof args.plan === "string" && args.plan.trim().length > 0) {
        const host = getHost(ctx);
        if (host) {
          try {
            host.updateCodingPlan(sessionId, args.plan);
             emit("plan-note", { noteId: undefined, planContent: args.plan });
          } catch (err) {
            console.warn("[cordis] failed to persist plan_content:", err);
          }
        }
      }

      return;
    }

    // ── todos: dsh-tool-todo appends a `todo/write` snapshot ({todos:
    // [{content, status}]}) per write — map it to Cairn's session_todos +
    // emit. NOTE: the tool RESULT is rendered text ("Updated todo list: …"),
    // never JSON, so parsing the output (as the old tool/result branch did)
    // always threw and the dock never populated. Read the snapshot event.
    if (event.type === "todo/write") {
      const host = getHost(ctx);
      if (host) {
        try {
          const data = event.data as { todos?: Array<{ content?: unknown; status?: unknown }> };
          const list = Array.isArray(data.todos)
            ? data.todos
                .filter((t) => typeof t?.content === "string")
                .map((t) => ({
                  content: t.content as string,
                  status: (t.status === "in_progress" || t.status === "completed" ? t.status : "pending") as
                    | "pending"
                    | "in_progress"
                    | "completed",
                  priority: "medium" as const,
                }))
            : [];
          host.saveSessionTodos(sessionId, list);
          emit("todos", { todos: host.getSessionTodos(sessionId) });
        } catch { /* non-critical */ }
      }
      return;
    }

    // ── Tool result (after execution) ────────────────────────────────────────
    if (event.type === "tool/result") {
      const result = readToolResult((event.data as { message?: unknown }).message);
      const callId = result?.callId;
      const output = result?.output ?? "";
      const name = callId ? (callName.get(callId) ?? "tool") : "tool";
      const ok = result?.isError !== true;
      // ── note-updated: after a note-write tool, push fresh note content so the
      // plan task list updates live (mirrors builtin NOTE_WRITE_TOOLS handling).
      const host = getHost(ctx);
      if (ok && host && ["ensure_note", "patch_note", "append_to_note"].includes(name)) {
        try {
          const parsed = JSON.parse(output) as { id?: string };
          if (parsed?.id) {
            const content = host.readNoteContent(parsed.id);
             if (content !== undefined) emit("note-updated", { noteId: parsed.id, content });
          }
        } catch { /* non-JSON output — ignore */ }
      }

      // ── plan-note: in plan mode, notify the renderer when the agent writes the PRD note.
      if (mode === "plan" && ok && name === "ensure_note") {
        try {
          const parsed = JSON.parse(output) as { id?: string };
           if (parsed?.id) emit("plan-note", { noteId: parsed.id });
        } catch { /* non-JSON output — ignore */ }
      }

      // (todos are handled from the `todo/write` snapshot event above — the
      // tool result here is rendered text, not JSON.)
      return;
    }

    // ── Retry: dsh-llm-retry records a durable llm/retry before each wait ─────
    if (event.type === "llm/retry") {
      const d = event.data as { retry?: number; maxRetries?: number; delayMs?: number; failure?: { message?: string; code?: string } };
       emit("retry", {
        attempt: (d.retry ?? 0) + 1,
        maxRetries: d.maxRetries ?? 0,
        delayMs: d.delayMs ?? 0,
        error: d.failure?.message ?? d.failure?.code ?? "Model request failed",
      });
      return;
    }

    // ── Compaction: BasicCompactionEngine auto-compacts at 80% context ────────
    if (event.type === "compaction/start") {
       emit("compact", { status: "start" });
      return;
    }
    if (event.type === "compaction/summary") {
      // Remember the latest summary text + replaced-node count so compaction/end
      // can report them (compaction/end carries only lifecycle data).
      const d = event.data as { summary?: unknown; shadowedSeqs?: unknown[] };
      const s = d.summary;
      lastCompactSummary = typeof s === "string" ? s : (Array.isArray(s) ? s.filter((b) => (b as { type?: string }).type === "text").map((b) => (b as { text?: string }).text ?? "").join("") : "");
      lastCompactCount = Array.isArray(d.shadowedSeqs) ? d.shadowedSeqs.length : 0;
      return;
    }
    if (event.type === "compaction/end") {
      // A failed close records an `error` on the end marker — don't claim success.
      const failed = (event.data as { error?: unknown }).error !== undefined;
       emit("compact", { status: "end", auto: true });
      if (!failed) {
         emit("compact-result", { messageCount: lastCompactCount, summary: lastCompactSummary });
      }
      lastCompactSummary = "";
      lastCompactCount = 0;
      return;
    }

  });
}
