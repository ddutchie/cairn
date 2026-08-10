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
 */

import { parse as parsePartialJson } from "partial-json";

/**
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
 *   3. MISSING commas between a completed value and the next token — the model
 *      dropped the `,` between two properties/elements (e.g. `{"title":"X"`
 *      "spaceId":"S"}`). A comma is the ONLY legal separator between two JSON
 *      values, so a value directly followed by a new key/element can only mean a
 *      dropped comma. We track the last significant token and, when a completed
 *      value is immediately followed by a token start (`"`, `{`, `[`, a digit,
 *      or `true`/`false`/`null`), we insert the missing `,` — purely structural,
 *      never merging adjacent text into one string, so decoded values are
 *      untouched. This is the fix for `Expected "," or "}" after property value`.
 *   4. DROPPED CLOSING DELIMITERS (tail repair) — a stream/gateway that ends the
 *      emission one token early leaves a structurally complete payload missing
 *      its final `"}`/`]`. We append the missing closers (unterminated trailing
 *      string first, then unclosed containers) and require the result to parse.
 *      String bytes are never altered. See `tailRepairJson` for the safety
 *      boundary: whether a tail-repaired payload may be EXECUTED is the CALLER's
 *      decision, driven by finish_reason (natural finish = safe; `length` =
 *      only the truncation guards may recover, flagged via `tailRepaired`).
 *   5. VALUE-START PLACEHOLDER TOKENS (`<arg_value>` et al.) — some models
 *      (e.g. served through gateways trained on templated tool-call data) emit a
 *      literal placeholder token where the opening quote of a string value
 *      should go, then dump the real content right after it:
 *      `"oldText":<arg_value>from adsk_openairouter…`. `<arg_value>` is not
 *      JSON at all (bare `<`), so no parse can recover it. We substitute a `"`
 *      for a known placeholder token ONLY when it appears at a value-start
 *      position OUTSIDE a string (the token is otherwise unrecognisable JSON —
 *      if it were inside a string it would be literal user/model content and
 *      MUST be preserved, exactly like the code-fence rule below). The string
 *      so opened is closed by the SAME placeholder token if the model also used
 *      one as the closing quote (`<arg_value>…content…</arg_value>`); a plain
 *      `"` closes it as usual.
 *
 * If the lossless repair pass still can't produce strict JSON, we delegate to the
 * `partial-json` library — the tolerant LLM-JSON parser used by the Vercel AI SDK
 * and by pi — as a final structural net (e.g. a dropped `:` between a key and its
 * value). Critically, it is invoked with ALL partial/truncation tolerance DISABLED
 * (`allow=0`): the library still accepts well-formed-but-underspecified structure
 * (its object parser treats commas as optional), but it *throws* on incomplete
 * input — truncated strings, objects, numbers, arrays — so a cut-off stream can
 * never silently dispatch a tool with partial arguments (the v2.1.9 regression
 * we fixed). `partial-json` never rewrites string bytes either, so decoded values
 * still round-trip exactly.
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
  | { ok: true; value: Record<string, unknown>; repaired: boolean; tailRepaired?: boolean }
  | { ok: false; error: string };

/**
 * Single context-aware repair pass. Walks the text tracking string context, the
 * enclosing container stack, and the last significant token, applying ONLY the
 * three lossless repairs above:
 *   - inside a string: escape raw control chars (< U+0020) to their JSON escape.
 *   - outside a string: drop a comma that is followed only by whitespace and then
 *     a `}` or `]` (a trailing comma).
 *   - outside a string: when a completed VALUE is immediately followed by the
 *     start of a new token (`"`, `{`, `[`, a digit, or `true`/`false`/`null`),
 *     insert the missing `,` separator.
 *   - outside a string, at a VALUE-START position (`:`, `,`, `{`, `[`, or start
 *     of input): a known placeholder token (`<arg_value>`, `<value>`, `<content>`)
 *     is substituted with `"`. The model dropped the opening quote of the string
 *     value and wrote a template placeholder in its place; the real content
 *     follows. Substituting `"` re-enters string mode so the content is consumed
 *     as a string value and the closing quote (which the model did emit) closes
 *     it. If the model instead closed the value with the same placeholder token
 *     (`…</arg_value>` or `…<arg_value>`), that closing occurrence is likewise
 *     turned into a `"`. Never substituted inside a string — there `<arg_value>`
 *     is literal content and must round-trip byte-identically.
 *
 * The last-significant-token state is what makes the comma repair safe: it only
 * fires after a genuinely completed value (string, number, literal, or nested
 * container), never after a key, `:`, `,`, or `{`/`[`. Because we never alter
 * the decoded text of any string value, `JSON.parse` of the result yields
 * byte-identical string values to what the model intended.
 */
const VALUE_PLACEHOLDER_TOKENS = ["<arg_value>", "<value>", "<content>", "<text>"];

function repairJson(src: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let stringIsKey = false;
  let lastSig: TokenKind = "none";
  // Set to the token text (e.g. `<arg_value>`) when a string value was opened by
  // a placeholder substitution — a subsequent occurrence of that same token
  // (with or without a leading `/`) closes the string instead of being content.
  let placeholderOpen: string | null = null;
  const stack: ("{" | "[")[] = [];

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
      // A string opened by a placeholder substitution is closed by the SAME
      // placeholder token (or its `/`-prefixed form) — the model used the token
      // as both the opening and closing quote of the value.
      if (placeholderOpen !== null) {
        const tok = placeholderOpen;
        const closeTok = `</${tok.slice(1)}`;
        if (src.startsWith(closeTok, i) || src.startsWith(tok, i)) {
          const hit = src.startsWith(closeTok, i) ? closeTok : tok;
          out += '"';
          inString = false;
          placeholderOpen = null;
          lastSig = "stringValue";
          i += hit.length - 1;
          continue;
        }
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        placeholderOpen = null;
        lastSig = stringIsKey ? "stringKey" : "stringValue";
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
      // A string directly after a completed value means a dropped comma (in an
      // object it is the next key, in an array the next element).
      if (isValueKind(lastSig)) out += ",";
      // In an object, a string is a KEY only right after `{` or `,`; everywhere
      // else (arrays, after `:`) it is a VALUE.
      stringIsKey = stack[stack.length - 1] === "{" && (lastSig === "openObject" || lastSig === "comma");
      out += ch;
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (isValueKind(lastSig)) out += ",";
      out += ch;
      stack.push("{");
      lastSig = "openObject";
      continue;
    }
    if (ch === "[") {
      if (isValueKind(lastSig)) out += ",";
      out += ch;
      stack.push("[");
      lastSig = "openArray";
      continue;
    }
    if (ch === "}") {
      out += ch;
      if (stack[stack.length - 1] === "{") stack.pop();
      lastSig = "close"; // a nested object is a completed value of its parent
      continue;
    }
    if (ch === "]") {
      out += ch;
      if (stack[stack.length - 1] === "[") stack.pop();
      lastSig = "close";
      continue;
    }
    if (ch === ",") {
      // Look ahead past whitespace: if the next non-space char is } or ], this is
      // a trailing comma → drop it. Structural-only; string content is unreachable
      // here because commas inside strings are handled by the inString branch.
      let j = i + 1;
      while (j < src.length && (src[j] === " " || src[j] === "\t" || src[j] === "\n" || src[j] === "\r")) j++;
      if (j < src.length && (src[j] === "}" || src[j] === "]")) {
        continue; // skip the comma; lastSig stays the completed value
      }
      out += ch;
      lastSig = "comma";
      continue;
    }
    if (ch === ":") {
      out += ch;
      lastSig = "colon";
      continue;
    }
    // Numbers: a digit or `-` starts a numeric literal.
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      if (isValueKind(lastSig)) out += ",";
      let j = i;
      while (j < src.length && isNumberChar(src[j])) j++;
      out += src.slice(i, j);
      i = j - 1;
      lastSig = "number";
      continue;
    }
    // Literals: true | false | null.
    if (ch === "t" && src.startsWith("true", i)) {
      if (isValueKind(lastSig)) out += ",";
      out += "true";
      i += 3;
      lastSig = "literal";
      continue;
    }
    if (ch === "f" && src.startsWith("false", i)) {
      if (isValueKind(lastSig)) out += ",";
      out += "false";
      i += 4;
      lastSig = "literal";
      continue;
    }
    if (ch === "n" && src.startsWith("null", i)) {
      if (isValueKind(lastSig)) out += ",";
      out += "null";
      i += 3;
      lastSig = "literal";
      continue;
    }

    // Value-start placeholder tokens: the model dropped the opening quote of a
    // string value and wrote a template placeholder (`<arg_value>`) in its
    // place, with the real content following. Substitute `"` and enter string
    // mode so the following content is consumed as that string value (raw
    // control chars inside it get escaped by the in-string branch above) and
    // the closing quote the model DID emit closes it. Only fires at a true
    // VALUE-start position outside a string: after `:` (an object value), after
    // `[`, or after an ARRAY comma. Object key positions — right after `{` or an
    // OBJECT comma — are never values, so a placeholder there is left untouched
    // (it will surface as a loud parse failure). Inside a string the token is
    // literal content and passes through untouched.
    if (
      ch === "<" &&
      isValueStart(lastSig, stack[stack.length - 1])
    ) {
      let hit = -1;
      for (let k = 0; k < VALUE_PLACEHOLDER_TOKENS.length; k++) {
        const tok = VALUE_PLACEHOLDER_TOKENS[k];
        if (src.startsWith(tok, i)) { hit = k; break; }
      }
      if (hit >= 0) {
        // Require real content after the placeholder — a bare `<arg_value>`
        // with nothing following (only `"`, `,`, `}` or `]` ahead) means the
        // model replaced the whole value, not just the opening quote; turning
        // that into `""` via the tail repair would be a silent wrong value.
        // Leave it to fail loudly instead.
        let j = i + VALUE_PLACEHOLDER_TOKENS[hit].length;
        while (j < src.length && (src[j] === " " || src[j] === "\t" || src[j] === "\n" || src[j] === "\r")) j++;
        if (j >= src.length || src[j] === '"' || src[j] === "," || src[j] === "}" || src[j] === "]") {
          // fall through to the unrecognised-token path below
        } else {
          const tok = VALUE_PLACEHOLDER_TOKENS[hit];
          out += '"';
          inString = true;
          stringIsKey = false;
          placeholderOpen = tok;
          i += tok.length - 1;
          lastSig = "stringValue";
          continue;
        }
      }
    }

    // Whitespace and anything unrecognised pass through untouched; invalid
    // tokens still surface as a loud JSON.parse failure further down.
    out += ch;
  }

  return out;
}

/**
 * True when a VALUE (not a key) is expected next — the only place a value-start
 * placeholder token may be repaired. `container` is the enclosing container's
 * open bracket (the top of the repair stack). Object key positions — right
 * after `{` or after an object comma — are NOT value starts, so a placeholder
 * there is never repaired as a value. Array comma, `[`, and `:` are value
 * starts.
 */
function isValueStart(k: TokenKind, container: "{" | "[" | undefined): boolean {
  if (k === "none" || k === "colon" || k === "openArray") return true;
  if (k === "openObject") return false;
  if (k === "comma") return container === "[";
  return false;
}

/**
 * ── Tail repair — recovering a dropped closing delimiter ─────────────────────
 * Models (and stream-translating gateways) occasionally emit tool-call
 * arguments whose content is COMPLETE but whose trailing JSON delimiters never
 * arrive — e.g. `{"projectId":"…","title":"…","content":"…full note…` with the
 * closing `"}` missing. Strict parse fails, the lossless pass above has nothing
 * to fix (no missing comma/control char), and `partial-json` correctly refuses.
 *
 * This tier recovers exactly that case: it appends a closing `"` for an
 * unterminated trailing string and a `}`/`]` per unclosed container, then
 * requires the result to parse as a plain object. It NEVER touches bytes inside
 * the emitted text — string values round-trip byte-identically — so the ONLY
 * thing it can change is adding the delimiters the emitter left off.
 *
 * Safety boundary (the caller decides, not this function): a structurally
 * complete-but-unterminated payload is *indistinguishable* from a payload the
 * model was cut mid-string on — both end in an open string. `finish_reason`
 * tells them apart:
 *   - natural finish (`stop`/`tool_calls`) → the model ended; the content IS
 *     everything it emitted → repairing is provably lossless.
 *   - `length`/interrupted → the model was cut; the tail *may* be chopped →
 *     only callers that accept that risk (the truncation guards) may execute,
 *     and they flag it via `tailRepaired`.
 */
function tailRepairJson(src: string): string | null {
  let inString = false;
  let escaped = false;
  const stack: Array<"{" | "["> = [];
  // Last non-whitespace character seen OUTSIDE a string — used to refuse
  // repairing a (possibly truncated) trailing numeric literal.
  let lastSignificant: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; lastSignificant = '"'; continue; }
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      const open = ch === "}" ? "{" : "[";
      if (stack.length > 0 && stack[stack.length - 1] === open) stack.pop();
      // A mismatched closer is left on the stack; the final JSON.parse fails → null.
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
  }
  // Nothing open and nothing unterminated → not a tail case; leave to other tiers.
  if (!inString && stack.length === 0) return null;
  // A trailing digit/`-`/`+`/`.` outside a string is a (possibly truncated)
  // numeric literal — appending closers could silently drop digits the model
  // still intended to emit (e.g. `{"count": 12` → `{"count": 12}`). Refuse and
  // let the structural safety net fail loudly on the truncated number instead.
  if (
    !inString &&
    lastSignificant !== null &&
    (lastSignificant === "-" || lastSignificant === "+" || lastSignificant === "."
      || (lastSignificant >= "0" && lastSignificant <= "9"))
  ) {
    return null;
  }

  let out = src;
  if (inString) out += '"';
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === "{" ? "}" : "]";

  try {
    const value = JSON.parse(out);
    if (value && typeof value === "object" && !Array.isArray(value)) return out;
  } catch {
    /* mid-structure damage (e.g. an unterminated key) — not tail-repairable */
  }
  return null;
}

/** Kinds of the last significant token emitted outside a string. */
type TokenKind =
  | "none"
  | "openObject"
  | "openArray"
  | "close"
  | "stringKey"
  | "stringValue"
  | "number"
  | "literal"
  | "colon"
  | "comma";

/** A token that completed a VALUE — the precondition for a missing-comma repair. */
function isValueKind(k: TokenKind): boolean {
  return k === "close" || k === "stringValue" || k === "number" || k === "literal";
}

function isNumberChar(ch: string): boolean {
  return (
    ch === "-" || ch === "+" || ch === "." || ch === "e" || ch === "E" || (ch >= "0" && ch <= "9")
  );
}

/**
 * Parse LLM tool-call arguments with a strict-first, repair-fallback strategy.
 *
 * @param raw The assembled `function.arguments` string (may be empty/whitespace).
 * @returns A discriminated result. `repaired: true` means the strict parse failed
 *          but a repair/safety-net pass succeeded — useful for telemetry.
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
    //    decoded content of any string value. Covers raw control chars, trailing
    //    commas, and missing commas (incl. after numeric/boolean/container values).
    const repaired = repairJson(trimmed);
    try {
      const value = JSON.parse(repaired);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return { ok: true, value: value as Record<string, unknown>, repaired: true };
      }
    } catch {
      /* fall through to the tail repair */
    }

    // 2b. Tail repair — recover arguments that are structurally complete except
    // a missing closing `"}` / `]` (a dropped final delimiter). The emitted
    // string values are untouched; the caller (the truncation guards) decides
    // from finish_reason whether executing a tail-repaired payload is safe.
    const tail = tailRepairJson(repaired);
    if (tail !== null) {
      try {
        const value = JSON.parse(tail);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return { ok: true, value: value as Record<string, unknown>, repaired: true, tailRepaired: true };
        }
      } catch {
        /* fall through to the structural safety net */
      }
    }

    // 3. Structural safety net: `partial-json` (used by the Vercel AI SDK and pi).
    //    `allow=0` disables ALL partial/truncation tolerance, so a cut-off stream
    //    still throws here — but well-formed structure with a dropped separator
    //    (e.g. a missing `:`) is accepted. Never silently dispatches partial args.
    try {
      const value = parsePartialJson(repaired, 0);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        // `partial-json` happily ignores trailing content after a complete value,
        // so a model output like `{"title":"x"} and more…` would otherwise be
        // accepted with the tail silently dropped. Verify the parser consumed the
        // whole input: reject when any non-whitespace remains after the value.
        const extent = jsonValueExtent(repaired);
        if (extent < 0 || repaired.slice(extent).trim() !== "") {
          throw new Error("unconsumed content after tool-call arguments JSON");
        }
        return { ok: true, value: value as Record<string, unknown>, repaired: true };
      }
    } catch {
      /* fall through to structured failure */
    }

    return { ok: false, error: `malformed tool-call arguments JSON from model: ${(strictErr as Error).message}` };
  }
}

/**
 * Index just past the first complete JSON value in `src`, or -1 when no complete
 * value is found. Used to prove a tolerance-parsed string had no leftover
 * non-whitespace content. Handles nested objects/arrays, strings (with escapes),
 * numbers, and the `true`/`false`/`null` literals.
 */
function jsonValueExtent(src: string): number {
  let i = 0;
  const n = src.length;
  const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
  while (i < n && isWs(src[i])) i++;
  const first = src[i];
  if (first === "{") {
    // Balanced scan over the top-level object: every `{`/`[` increments depth,
    // `}`/`]` decrements — a well-formed value returns to 0 exactly at its end.
    let depth = 1;
    let inString = false;
    let escaped = false;
    i++;
    for (; i < n; i++) {
      const c = src[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (c === "\\") { escaped = true; continue; }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }
  if (first === "[") {
    // Arrays use the same balanced scan — treat as the object case above.
    let depth = 1;
    let inString = false;
    let escaped = false;
    i++;
    for (; i < n; i++) {
      const c = src[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (c === "\\") { escaped = true; continue; }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }
  if (first === '"') {
    i++;
    let escaped = false;
    for (; i < n; i++) {
      const c = src[i];
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === '"') return i + 1;
    }
    return -1;
  }
  const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
  if (number && number[0].length > 0) return i + number[0].length;
  const kw = src.slice(i, i + 5);
  if (kw.startsWith("true")) return i + 4;
  if (kw.startsWith("false")) return i + 5;
  if (kw.startsWith("null")) return i + 4;
  return -1;
}
