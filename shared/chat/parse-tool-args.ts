/**
 * Tolerant parser for LLM-emitted tool-call `arguments` JSON.
 *
 * The streamed `tool_calls[].function.arguments` string is supposed to be strict
 * JSON, but models frequently emit *nearly*-valid JSON — especially for tools
 * like `ensure_note`/`patch_note` whose `content` field carries markdown.
 *
 * `parseToolArgs` first attempts a strict `JSON.parse`. If that fails it applies
 * a small set of repairs and retries. On total failure it NEVER silently returns
 * `{}`: callers must surface a parse error so the model can re-issue the call.
 *
 * ── Repair safety contract (critical) ────────────────────────────────────────
 * Field VALUES — above all `content` — are user/model data and MUST round-trip
 * byte-identically. A repair is only permitted if it is *provably lossless* for
 * every string value. We therefore only repair things that are unambiguously
 * malformed JSON *structure*, never anything that could alter the decoded string:
 *
 *   1. Unescaped control characters INSIDE a string literal (a real newline/tab
 *      typed straight into `"content":"line1<LF>line2"` instead of `\n`). This is
 *      illegal JSON (RFC 8259 §7), and escaping it to `\n`/`\t`/… decodes back to
 *      the byte-identical character — lossless. This is the dominant note-write
 *      breakage.
 *   2. Trailing commas before a closing `}`/`]`, detected OUTSIDE string context
 *      so a literal comma inside content (e.g. "a,}") is never touched.
 *
 * Explicitly NOT repaired, because they would mutate content:
 *   - Stripping a wrapping ```code fence``` — indistinguishable from content that
 *     legitimately begins and ends with a fence; stripping would corrupt the note.
 *   - Rewriting smart/curly quotes to ASCII — the curly quotes may be genuine
 *     content ("AI theater"); rewriting them corrupts the note.
 * If the JSON is broken in a way these two safe repairs can't fix, we fail loudly
 * rather than guess and risk silently changing what the user's note says.
 */

export type ParseToolArgsResult =
  | { ok: true; value: Record<string, unknown>; repaired: boolean }
  | { ok: false; error: string };

/**
 * Single context-aware repair pass. Walks the text tracking string context and
 * escape state, applying ONLY the two lossless repairs above:
 *   - inside a string: escape raw control chars (< U+0020) to their JSON escape.
 *   - outside a string: drop a comma that is followed only by whitespace and then
 *     a `}` or `]` (a trailing comma).
 *
 * Because we never alter the decoded text of any string value, `JSON.parse` of
 * the result yields byte-identical string values to what the model intended.
 */
function repairJson(src: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inString) {
      if (escaped) {
        // Part of an escape sequence — pass through verbatim.
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      const code = src.charCodeAt(i);
      if (code < 0x20) {
        // Raw control char inside a string → escape (lossless).
        if (ch === "\n") out += "\\n";
        else if (ch === "\t") out += "\\t";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\b") out += "\\b";
        else if (ch === "\f") out += "\\f";
        else out += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += ch;
      continue;
    }

    // ── Outside a string ──
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      // Look ahead past whitespace: if the next non-space char is } or ], this is
      // a trailing comma → drop it. Structural-only; string content is unreachable
      // here because commas inside strings are handled by the inString branch.
      let j = i + 1;
      while (j < src.length && (src[j] === " " || src[j] === "\t" || src[j] === "\n" || src[j] === "\r")) j++;
      if (j < src.length && (src[j] === "}" || src[j] === "]")) {
        continue; // skip the comma
      }
      out += ch;
      continue;
    }
    out += ch;
  }

  return out;
}

/**
 * Parse LLM tool-call arguments with a strict-first, repair-fallback strategy.
 *
 * @param raw The assembled `function.arguments` string (may be empty/whitespace).
 * @returns A discriminated result. `repaired: true` means the strict parse failed
 *          but the lossless repair pass succeeded — useful for telemetry.
 */
export function parseToolArgs(raw: string | null | undefined): ParseToolArgsResult {
  const trimmed = (raw ?? "").trim();
  // Empty args is a legitimate no-arg tool call.
  if (trimmed === "") return { ok: true, value: {}, repaired: false };

  // 1. Strict parse — the happy path for well-behaved models. Well-formed JSON
  //    (including content that contains code fences, quotes, etc.) succeeds here
  //    untouched, so nothing is ever mutated on the common path.
  try {
    const value = JSON.parse(trimmed);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown>, repaired: false };
    }
    return { ok: false, error: `tool arguments must be a JSON object, got ${Array.isArray(value) ? "array" : typeof value}` };
  } catch (strictErr) {
    // 2. Lossless repair pass — only fixes malformed JSON structure, never the
    //    decoded content of any string value.
    try {
      const value = JSON.parse(repairJson(trimmed));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return { ok: true, value: value as Record<string, unknown>, repaired: true };
      }
    } catch {
      /* fall through to structured failure */
    }

    return { ok: false, error: `malformed tool-call arguments JSON from model: ${(strictErr as Error).message}` };
  }
}
