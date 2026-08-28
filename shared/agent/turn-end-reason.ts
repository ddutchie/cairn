/**
 * turn-end-reason — one human description of a DSH `turn/end` reason.
 *
 * Shared by the main process (coding-loop result strings, debug log) and the
 * renderer (the error bubble in AgentChatPane) so a failure reads the same
 * everywhere.
 *
 * Motivation: dsh's `TurnEndReason` is a sum type where the `error` variant
 * carries the only description of the failure in `reason.error` (an `LlmFailure`
 * of `{message, code}`). Cairn previously rendered nothing but `reason.kind`,
 * so every distinct failure — a bad plugin, an auth rejection, a rate limit —
 * surfaced as the identical, unactionable string
 * "Agent turn ended abnormally (error)".
 *
 * @see https://github.com/… dsh-session `TurnEndReasonMap`
 */

/** The structural subset of dsh's TurnEndReason that Cairn reads. */
export interface TurnEndReasonLike {
  kind?: string;
  /** Present on kind:"error" — the structured LlmFailure. */
  error?: { message?: string; code?: string };
  /** Present on kind:"aborted" — the cancellation cause. */
  reason?: { kind?: string };
}

/**
 * True when the turn ended in a way the user should never see an error for:
 * a clean finish, or a cancellation they themselves requested.
 */
export function isBenignTurnEnd(kind: string | undefined): boolean {
  return kind === "completed" || kind === "aborted";
}

/**
 * Render a `turn/end` reason as an actionable sentence.
 *
 * `UNKNOWN`-coded failures are thrown JS errors flattened by the agent loop
 * (`{message: errorChain(error), code: 'UNKNOWN'}`) — almost always a bug in a
 * mounted plugin rather than a provider fault, so they are labelled as internal
 * to stop them being misread as an upstream outage.
 */
export function describeTurnEndReason(reason: TurnEndReasonLike | undefined): string {
  const kind = reason?.kind;
  if (!kind) return "Agent turn ended abnormally";

  switch (kind) {
    case "error": {
      const message = reason?.error?.message?.trim();
      const code = reason?.error?.code;
      if (!message) return "Agent turn failed (no error detail reported)";
      return code === "UNKNOWN"
        ? `Agent turn failed — internal error: ${message}`
        : `Agent turn failed (${code ?? "error"}): ${message}`;
    }
    case "blocked":
      return "Agent turn was blocked before it ran — a plugin or approval gate rejected the step.";
    case "max-tokens":
      return "Agent turn stopped: the model hit its output-token ceiling.";
    case "interrupted":
      return "Agent turn was interrupted — the app closed or crashed mid-turn.";
    case "aborted": {
      const cause = reason?.reason?.kind;
      return cause ? `Agent turn was cancelled (${cause}).` : "Agent turn was cancelled.";
    }
    default:
      return `Agent turn ended abnormally (${kind})`;
  }
}
