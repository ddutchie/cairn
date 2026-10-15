/**
 * Which wire protocols an endpoint offers for a given model.
 *
 * Each probe is a request the server must reject at validation — an empty
 * message list, a one-token cap — so the route, the key and the model are
 * checked without running a generation. The answer is classified from the
 * status and the error text:
 *
 *   - available    the route answered for this model (2xx, or a validation error
 *                  about the request itself)
 *   - unsupported  the route exists but not for this model (OpenCode's "Model
 *                  does not support this protocol")
 *   - missing      no such route (404/405)
 *   - auth         the key was refused (401/403) — nothing else can be told
 *   - unknown      anything else (5xx, timeout, an unrecognisable 400)
 *
 * Pure: building requests and classifying replies only; callers do the fetch.
 */

export type ProbeProtocol = "completions" | "responses" | "anthropic-messages";
export type ProtocolAvailability = "available" | "unsupported" | "missing" | "auth" | "unknown";

export const PROBE_PROTOCOLS: readonly ProbeProtocol[] = ["completions", "responses", "anthropic-messages"];

/** Path (relative to the base URL) and JSON body for one protocol's probe. */
export function protocolProbeRequest(protocol: ProbeProtocol, model: string): { path: string; body: Record<string, unknown>; headers: Record<string, string> } {
  switch (protocol) {
    case "completions":
      return { path: "chat/completions", body: { model, messages: [], max_tokens: 1 }, headers: {} };
    case "responses":
      // 16 is the smallest max_output_tokens the Responses API accepts.
      return { path: "responses", body: { model, input: [], max_output_tokens: 16 }, headers: {} };
    case "anthropic-messages":
      return { path: "messages", body: { model, messages: [], max_tokens: 1 }, headers: { "anthropic-version": "2023-06-01" } };
  }
}

const UNSUPPORTED = /does not support (this|the) (protocol|api|endpoint)|(protocol|api|endpoint) (is )?not supported|unsupported (protocol|api|endpoint)|only (available|supported) (via|on|through) the/i;
// A validation error about the request body means the handler ran for this
// model: the route and the model are fine, our probe body just isn't.
const VALIDATION = /invalid_request|messages?|input|max_(output_)?tokens|required|missing|empty|at least|must (be|contain|have)|validation/i;

export function classifyProtocolProbe(status: number, bodyText: string): ProtocolAvailability {
  if (status === 404 || status === 405) return "missing";
  if (status === 401 || status === 403) return "auth";
  if (UNSUPPORTED.test(bodyText)) return "unsupported";
  if (status >= 200 && status < 300) return "available";
  if (status === 400 || status === 422) return VALIDATION.test(bodyText) ? "available" : "unknown";
  return "unknown";
}
