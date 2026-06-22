/**
 * Shared OpenAI-compatible SSE line parser.
 *
 * The naive pattern `decoder.decode(value, { stream: true }).split("\n")`
 * silently drops any SSE `data:` record that straddles a `reader.read()`
 * chunk boundary — the head fails `startsWith("data:")` on the trailing
 * fragment of one chunk, and the tail fails the same check on the leading
 * fragment of the next. For large streamed `tool_calls[].function.arguments`
 * deltas this corrupts the assembled JSON and (combined with Cairn's former
 * `catch { args = {} }` fall-through) leads to destructive tool calls with
 * missing/blank fields.
 *
 * This module keeps a running carry buffer across reads so partial lines
 * survive the boundary.
 */

/** Yields each fully-received SSE `data:` payload (the JSON string, or `[DONE]`). */
export async function* iterSseData(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let carry = "";

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      const parts = carry.split("\n");
      // The last element is always a partial line (no trailing newline) — keep it for next iteration.
      carry = parts.pop() ?? "";
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        yield payload;
      }
    }
    // Flush final decoder state and any trailing partial line.
    carry += decoder.decode();
    if (!carry) return;
    const trimmed = carry.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return;
    yield payload;
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
