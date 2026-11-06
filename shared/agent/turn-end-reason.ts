/**
 * turn-end-reason — one human description of a engine `turn/end` reason.
 *
 * Shared by the main process (coding-loop result strings, debug log) and the
 * renderer (the error bubble in AgentChatPane) so a failure reads the same
 * everywhere.
 *
 * Motivation: engine's `TurnEndReason` is a sum type where the `error` variant
 * carries the only description of the failure in `reason.error` (an `LlmFailure`
 * of `{message, code}`). Cairn previously rendered nothing but `reason.kind`,
 * so every distinct failure — a bad plugin, an auth rejection, a rate limit —
 * surfaced as the identical, unactionable string
 * "Agent turn ended abnormally (error)".
 *
 * @see https://github.com/… engine-session `TurnEndReasonMap`
 */

/** The structural subset of engine's TurnEndReason that Cairn reads. */
export interface TurnEndReasonLike {
  kind?: string;
  /** Present on kind:"error" — the structured LlmFailure. */
  error?: { message?: string; code?: string };
  /** Present on kind:"aborted" — the cancellation cause. */
  reason?: { kind?: string };
}

/**
 * True when the turn ended in a way the user should never see an error for:
 * a clean finish (`stop` is what the engine reports, `completed` is what older
 * session logs carry), or a cancellation they themselves requested.
 */
export function isBenignTurnEnd(kind: string | undefined): boolean {
  return kind === "stop" || kind === "completed" || kind === "aborted";
}

const AI_SETTINGS = "Settings → AI";

/** True when a failure notice sends the user to AI settings, so the UI can offer a shortcut. */
export function pointsToAISettings(notice: string): boolean {
  return notice.includes(AI_SETTINGS);
}

/** The provider's own words from a raw failure, without its status code or JSON wrapping. */
function providerDetail(message: string): string {
  const body = message.replace(/^[^{]*?\b\d{3}\b[:\s-]*/, "").trim();
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: { message?: unknown } | string };
    const nested = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    const found = parsed.message ?? nested;
    detail = typeof found === "string" ? found : "";
  } catch { /* not JSON: keep the text as it is */ }
  return detail.length > 160 ? `${detail.slice(0, 160)}…` : detail;
}

/** A sentence saying what to do about a common provider failure, or undefined for anything else. */
function describeProviderFailure(message: string): string | undefined {
  if (/^missing api key/i.test(message)) return message;
  const withDetail = (text: string) => {
    const detail = providerDetail(message);
    return detail ? `${text} (${detail})` : text;
  };
  const status = /^(?:[a-z ]*error:?\s*)?(?:http\s*)?(?:status code\s*)?(\d{3})\b/i.exec(message)?.[1];
  if (status === "401") return withDetail(`The provider rejected your API key. Check it in ${AI_SETTINGS}.`);
  if (status === "403") return withDetail(`The provider refused this request. Check your key and plan in ${AI_SETTINGS}.`);
  if (status === "404") return withDetail(`The provider couldn't find this model or address. Check them in ${AI_SETTINGS}.`);
  if (status === "429") return withDetail("The provider is limiting requests, or your account is out of quota. Try again in a moment.");
  if (/econnrefused|enotfound|eai_again|getaddrinfo|fetch failed|connection error|network error/i.test(message)) {
    return `Couldn't reach the provider. Check your connection and the address in ${AI_SETTINGS}. For a local provider, make sure its server is running.`;
  }
  return undefined;
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
    case "stop":
    case "completed":
      return "Agent turn finished.";
    case "error": {
      const message = reason?.error?.message?.trim();
      const code = reason?.error?.code;
      if (!message) return "Agent turn failed (no error detail reported)";
      const known = describeProviderFailure(message);
      if (known) return known;
      if (code === "UNKNOWN") return `Agent turn failed — internal error: ${message}`;
      return code ? `Agent turn failed (${code}): ${message}` : `Agent turn failed: ${message}`;
    }
    case "max-steps":
      return "Agent turn stopped: it reached the step limit. Send another message to continue.";
    case "overflow":
      return "Agent turn stopped: the conversation no longer fits this model's context, even after compacting. Start a new session or switch to a model with a larger context.";
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
