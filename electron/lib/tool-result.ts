/**
 * Shared tool-result status detection.
 *
 * Cairn tools signal failure in TWO ways:
 *   1. Throwing an exception (file/coding tools, external MCP transport errors).
 *   2. Returning a plain object with a truthy `error` field WITHOUT throwing —
 *      this is the dominant pattern for the built-in Cairn tools (see the many
 *      `chat-executor.ts` cases that `return { error: "…" }`).
 *
 * Historically only (1) was treated as a failure by the loops, so a tool that
 * returned `{ error: "Project not found" }` was reported to the UI as a success
 * (green checkmark) even though nothing happened. This helper is the single
 * source of truth both the chat loop and the agent loop use to classify a
 * (non-throwing) tool result, so the model-facing tool message, the loop's `ok`
 * flag, and the renderer chip can never disagree.
 */

/** A tool result carries an error if it is an object with a truthy `error` field. */
export function toolResultError(result: unknown): string | undefined {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const err = (result as Record<string, unknown>).error;
    if (err !== undefined && err !== null && err !== false && err !== "") {
      return typeof err === "string" ? err : JSON.stringify(err);
    }
  }
  return undefined;
}

/** True when a (non-throwing) tool result represents success. */
export function isToolResultOk(result: unknown): boolean {
  return toolResultError(result) === undefined;
}

/**
 * Same as `toolResultError`, but for a tool result that has already been
 * serialised to a string (the agent loop stores `resultContent` as a JSON
 * string). Non-JSON strings are treated as success — a plain text result is a
 * normal successful output, not an error object.
 */
export function resultContentError(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return toolResultError(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

/**
 * Detect failure in an EXTERNAL tool's string output. MCP servers and custom
 * HTTP services return a plain string; by convention a failure is prefixed with
 * `Error:` / `Error calling …` (see external-tools.ts, custom-services.ts,
 * mcp-client.ts). Returns the message when the output signals an error, else
 * undefined. (These are plain text, not JSON, so `resultContentError` can't be
 * used here.)
 */
export function externalOutputError(output: string): string | undefined {
  const trimmed = output.trimStart();
  return /^Error[:\s]/.test(trimmed) ? output.trim() : undefined;
}
