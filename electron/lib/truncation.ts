/**
 * Unified output truncation for coding tool results.
 *
 * Replaces ad-hoc per-tool truncation with a single consistent contract:
 *   - Byte-budget enforcement (hard cap)
 *   - Optional line-count cap
 *   - Structured result so callers can append pagination hints
 *
 * The model receives a `[Truncated …]` suffix so it knows output is incomplete
 * and can use offset/limit parameters to page through large results.
 */

export interface TruncationResult {
  /** The (possibly truncated) text to return to the model. */
  text: string;
  /** True if the output was cut short. */
  truncated: boolean;
  /** Total byte length of the original output. */
  totalBytes: number;
  /** Byte length of the text actually returned. */
  shownBytes: number;
  /** Total line count of the original output (undefined if not line-based). */
  totalLines?: number;
  /** Line count returned (undefined if not line-based). */
  shownLines?: number;
}

export interface TruncateOptions {
  /** Hard byte cap. Defaults to DEFAULT_MAX_BYTES. */
  maxBytes?: number;
  /** Optional line cap applied before byte cap. */
  maxLines?: number;
  /**
   * Hint appended when truncated. Use {shown} and {total} as placeholders.
   * Defaults to a generic message.
   */
  hint?: string;
}

export const DEFAULT_MAX_BYTES = 50_000;
export const DEFAULT_MAX_LINES = 2_000;

/**
 * Truncate `text` to fit within byte and/or line budgets.
 * Always appends a human-readable hint when truncation occurs so the model
 * knows to use offset/limit to retrieve the rest.
 */
export function truncateOutput(text: string, opts: TruncateOptions = {}): TruncationResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = opts.maxLines;
  const totalBytes = Buffer.byteLength(text, "utf8");

  let working = text;
  let totalLines: number | undefined;
  let shownLines: number | undefined;

  // ── Line cap ──────────────────────────────────────────────────────────────
  if (maxLines !== undefined) {
    const lines = working.split("\n");
    totalLines = lines.length;
    if (lines.length > maxLines) {
      working = lines.slice(0, maxLines).join("\n");
      shownLines = maxLines;
    } else {
      shownLines = lines.length;
    }
  }

  // ── Byte cap ──────────────────────────────────────────────────────────────
  const workingBytes = Buffer.byteLength(working, "utf8");
  if (workingBytes <= maxBytes) {
    // No byte truncation needed
    const truncated = working.length < text.length; // line-cap fired
    const shownBytes = workingBytes;
    if (truncated) {
      const hint = buildHint(opts.hint, shownLines, totalLines, shownBytes, totalBytes);
      return { text: working + hint, truncated: true, totalBytes, shownBytes, totalLines, shownLines };
    }
    return { text: working, truncated: false, totalBytes, shownBytes, totalLines, shownLines };
  }

  // Byte-trim: walk chars until budget exhausted
  let budget = maxBytes;
  // Use a buffer approach to avoid O(n²) string concat
  const encoder = new TextEncoder();
  const chars: string[] = [];
  for (const char of working) {
    const charBytes = encoder.encode(char).length;
    if (budget - charBytes < 0) break;
    chars.push(char);
    budget -= charBytes;
  }

  const trimmed = chars.join("");
  const shownBytes = Buffer.byteLength(trimmed, "utf8");

  // Update shownLines after byte trim
  if (maxLines !== undefined) {
    shownLines = trimmed.split("\n").length;
  }

  const hint = buildHint(opts.hint, shownLines, totalLines, shownBytes, totalBytes);
  return { text: trimmed + hint, truncated: true, totalBytes, shownBytes, totalLines, shownLines };
}

function buildHint(
  template: string | undefined,
  shownLines: number | undefined,
  totalLines: number | undefined,
  shownBytes: number,
  totalBytes: number,
): string {
  if (template) {
    return "\n\n" + template
      .replace("{shown}", String(shownLines ?? shownBytes))
      .replace("{total}", String(totalLines ?? totalBytes));
  }
  if (shownLines !== undefined && totalLines !== undefined) {
    return `\n\n[Truncated: showed ${shownLines} of ${totalLines} lines (${fmt(shownBytes)} of ${fmt(totalBytes)}). Use offset/limit to page.]`;
  }
  return `\n\n[Truncated: showed ${fmt(shownBytes)} of ${fmt(totalBytes)}. Use offset/limit to page.]`;
}

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
