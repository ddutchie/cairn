/**
 * message-feedback — main-side host for per-message thumbs ratings + notes.
 *
 * Thin wrapper over dsh's `ctx.messageFeedback` (ENTRY_LIST-mounted in
 * `cordis-context.ts` with the storage hub + JSON backend + domain facility).
 * The renderer drives it through the `session:feedback` / `session:feedback-get`
 * IPC channels ({ok:true,value}|{ok:false,code,message} envelope, same as
 * `subagent:*`); the log-only `/feedback` command needs no bridge — it
 * surfaces through the existing `cordis:listCommands` merge for free.
 *
 * Compare-and-set discipline: every `put` must carry the addressed item's
 * observed version. `putMessageFeedback` reads it via `list` first and
 * retries once on `version-conflict` with the authoritative current version,
 * so a rating click is a single renderer call. An omitted note preserves a
 * stored note (upstream clears it on omit — we re-attach the observed one).
 */

import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";

export type MessageFeedbackRating = "positive" | "negative";

export interface MessageFeedbackItemWire {
  messageId: string;
  rating: MessageFeedbackRating;
  note?: string;
  version: string;
  createdAt: number;
  updatedAt: number;
}

export interface PutMessageFeedbackInput {
  sessionId: string;
  messageId: string;
  rating: MessageFeedbackRating;
  note?: string;
}

type ServiceResult<T, E = { code?: string }> = { ok: true; value: T } | { ok: false; error: E };

interface MessageFeedbackServiceLike {
  list: (req: { sessionId: unknown }) => Promise<ServiceResult<{ items: MessageFeedbackItemWire[] }>>;
  put?: (req: { sessionId: unknown; messageId: unknown; rating: string; note?: string; ifVersion: string | null }) => Promise<ServiceResult<MessageFeedbackItemWire, { code: string; current?: MessageFeedbackItemWire | null }>>;
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function feedbackService(ctx: Context): MessageFeedbackServiceLike {
  const service = (ctx as unknown as { messageFeedback?: MessageFeedbackServiceLike }).messageFeedback;
  if (!service || typeof service.list !== "function") {
    throw coded("unavailable", "message feedback unavailable (service not mounted)");
  }
  return service;
}

function failureMessage(error: { code?: string }): string {
  switch (error.code) {
    case "session-not-found": return "session not found";
    case "target-not-found": return "message is not a ratable assistant message";
    case "version-conflict": return "rating changed elsewhere — retry";
    case "note-blank": return "note must not be blank";
    case "note-too-large": return "note exceeds the 8192-byte limit";
    default: return `feedback failed (${error.code ?? "unknown"})`;
  }
}

/**
 * Rate (or re-rate) one assistant message, preserving a stored note unless a
 * replacement is supplied. Throws coded errors for the IPC envelope.
 */
export async function putMessageFeedback(ctx: Context, input: PutMessageFeedbackInput): Promise<MessageFeedbackItemWire> {
  if (input.rating !== "positive" && input.rating !== "negative") {
    throw coded("bad-request", "rating must be positive or negative");
  }
  if (!input.sessionId || !input.messageId) {
    throw coded("bad-request", "sessionId and messageId are required");
  }
  const service = feedbackService(ctx);
  if (typeof service.put !== "function") {
    throw coded("unavailable", "message feedback unavailable (service not mounted)");
  }
  const put = service.put.bind(service);
  const sessionId = SessionId(input.sessionId);

  const listed = await service.list({ sessionId });
  if (!listed.ok) throw coded(listed.error.code ?? "internal", failureMessage(listed.error));
  const existing = listed.value.items.find((item) => item.messageId === input.messageId);

  // Upstream clears a stored note when `note` is omitted — re-attach the
  // observed one so a bare thumb click never destroys note text.
  let note = input.note !== undefined ? input.note : existing?.note;

  const attempt = (ifVersion: string | null) =>
    put({
      sessionId,
      messageId: input.messageId,
      rating: input.rating,
      ...(note !== undefined ? { note } : {}),
      ifVersion,
    });

  let result = await attempt(existing?.version ?? null);
  if (!result.ok && result.error.code === "version-conflict") {
    // A concurrent writer changed the note after our list — refresh from
    // their version so the retry doesn't clobber it with our stale copy.
    // A caller-supplied replacement note still wins.
    if (input.note === undefined) note = result.error.current?.note;
    result = await attempt(result.error.current?.version ?? null);
  }
  if (!result.ok) throw coded(result.error.code ?? "internal", failureMessage(result.error));
  return result.value;
}

/**
 * Read one message's current rating, or null when unrated (or when the
 * session itself is unknown — the bubble then renders the unrated state).
 * Throws coded errors only for infrastructure failures.
 */
export async function getMessageFeedback(
  ctx: Context,
  sessionId: string,
  messageId: string,
): Promise<MessageFeedbackItemWire | null> {
  const service = feedbackService(ctx);
  const listed = await service.list({ sessionId: SessionId(sessionId) });
  if (!listed.ok) {
    if (listed.error.code === "session-not-found") return null;
    throw coded(listed.error.code ?? "internal", failureMessage(listed.error));
  }
  return listed.value.items.find((item) => item.messageId === messageId) ?? null;
}
