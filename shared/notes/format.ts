/**
 * Pure markdown formatting transforms for a plain-text editor model
 * (string + { start, end } selection). This mirrors the desktop CodeMirror
 * `applyFormat` (src/components/notes/ai-text-toolbar.tsx) but operates on a
 * plain string so it can drive the mobile React Native TextInput — and stays
 * unit-testable with no editor dependency.
 *
 * Every transform returns the new full text plus the selection to restore, so
 * the caller can set both on the TextInput.
 */

export type FormatAction =
  | "bold"
  | "italic"
  | "strikethrough"
  | "code"
  | "highlight"
  | "link"
  | "h1"
  | "h2"
  | "h3"
  | "quote"
  | "bullet"
  | "ordered"
  | "task"
  | "codeblock"
  | "hr"
  | "wikilink";

export interface Selection {
  start: number;
  end: number;
}

export interface FormatResult {
  text: string;
  selection: Selection;
}

/** Inline actions require a selection to wrap; line actions work on the cursor line. */
export const REQUIRES_SELECTION: ReadonlySet<FormatAction> = new Set<FormatAction>([
  "bold",
  "italic",
  "strikethrough",
  "highlight",
  "code",
  "link",
]);

interface WrapDef {
  open: string;
  close: string;
  placeholder: string;
}

const WRAP: Partial<Record<FormatAction, WrapDef>> = {
  bold: { open: "**", close: "**", placeholder: "bold text" },
  italic: { open: "_", close: "_", placeholder: "italic text" },
  strikethrough: { open: "~~", close: "~~", placeholder: "strikethrough" },
  highlight: { open: "==", close: "==", placeholder: "highlighted text" },
  code: { open: "`", close: "`", placeholder: "code" },
};

const LINE_PREFIX: Partial<Record<FormatAction, string>> = {
  h1: "# ",
  h2: "## ",
  h3: "### ",
  quote: "> ",
  bullet: "- ",
  ordered: "1. ",
  task: "- [ ] ",
};

/** Slice helpers so the transforms read like the CodeMirror version. */
function replaceRange(text: string, start: number, end: number, insert: string): string {
  return text.slice(0, start) + insert + text.slice(end);
}

/** Index of the start of the line containing `pos`. */
function lineStart(text: string, pos: number): number {
  const nl = text.lastIndexOf("\n", pos - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** Index of the end of the line containing `pos` (before the trailing \n). */
function lineEnd(text: string, pos: number): number {
  const nl = text.indexOf("\n", pos);
  return nl === -1 ? text.length : nl;
}

/**
 * Apply a formatting action to `text` at `selection`. Returns the new text and
 * the selection to restore, or `null` for actions the caller must handle
 * (currently only `wikilink`, which opens a picker).
 */
export function applyFormat(
  text: string,
  selection: Selection,
  action: FormatAction,
): FormatResult | null {
  const { start, end } = normalize(selection, text.length);
  const selected = text.slice(start, end);

  // ── Inline wrapping ───────────────────────────────────────────────────────
  const wrap = WRAP[action];
  if (wrap) {
    const { open, close, placeholder } = wrap;
    const isWrapped =
      selected.startsWith(open) &&
      selected.endsWith(close) &&
      selected.length > open.length + close.length;

    if (isWrapped) {
      const inner = selected.slice(open.length, selected.length - close.length);
      return {
        text: replaceRange(text, start, end, inner),
        selection: { start, end: start + inner.length },
      };
    }
    if (selected.length === 0) {
      const insert = open + placeholder + close;
      return {
        text: replaceRange(text, start, end, insert),
        selection: { start: start + open.length, end: start + open.length + placeholder.length },
      };
    }
    const insert = open + selected + close;
    return {
      text: replaceRange(text, start, end, insert),
      selection: { start, end: start + insert.length },
    };
  }

  // ── Link ────────────────────────────────────────────────────────────────
  if (action === "link") {
    const linkMatch = selected.match(/^\[(.+?)\]\(.+?\)$/);
    if (linkMatch) {
      const inner = linkMatch[1];
      return {
        text: replaceRange(text, start, end, inner),
        selection: { start, end: start + inner.length },
      };
    }
    if (selected.length === 0) {
      const insert = "[link text](url)";
      return {
        text: replaceRange(text, start, end, insert),
        selection: { start: start + 1, end: start + 10 },
      };
    }
    const insert = `[${selected}](url)`;
    return {
      text: replaceRange(text, start, end, insert),
      selection: { start: start + selected.length + 3, end: start + insert.length - 1 },
    };
  }

  // ── Line-level prefixes (toggle) ──────────────────────────────────────────
  const prefix = LINE_PREFIX[action];
  if (prefix) {
    const from = lineStart(text, start);
    const to = lineEnd(text, end);
    const block = text.slice(from, to);
    const lines = block.split("\n");

    const hasPrefix =
      action === "ordered"
        ? (l: string) => /^\d+\.\s/.test(l)
        : (l: string) => l.startsWith(prefix);
    const allHave = lines.every(hasPrefix);

    let orderedIndex = 1;
    const out = lines.map((line) => {
      const stripped = line
        .replace(/^(#{1,6}\s)/, "")
        .replace(/^(>\s)/, "")
        .replace(/^(-\s\[[ xX]\]\s)/, "")
        .replace(/^(-\s)/, "")
        .replace(/^(\d+\.\s)/, "");
      if (allHave) return stripped;
      const p = action === "ordered" ? `${orderedIndex++}. ` : prefix;
      return p + stripped;
    });

    const newBlock = out.join("\n");
    return {
      text: replaceRange(text, from, to, newBlock),
      selection: { start: from, end: from + newBlock.length },
    };
  }

  // ── Code block (toggle fences) ────────────────────────────────────────────
  if (action === "codeblock") {
    const inner = selected.length > 0 ? selected : "code here";
    const insert = "```\n" + inner + "\n```";
    const from = lineStart(text, start);
    const to = selected.length > 0 ? lineEnd(text, end) : lineEnd(text, start);
    return {
      text: replaceRange(text, from, to, insert),
      // Select the inner content (after the opening fence + newline).
      selection: { start: from + 4, end: from + 4 + inner.length },
    };
  }

  // ── Horizontal rule ───────────────────────────────────────────────────────
  if (action === "hr") {
    const from = lineStart(text, start);
    const to = lineEnd(text, start);
    const curLine = text.slice(from, to);
    const blank = curLine.trim() === "";
    const insert = (blank ? "" : "\n") + "---\n";
    const pos = blank ? from : to;
    return {
      text: replaceRange(text, pos, pos, insert),
      selection: { start: pos + insert.length, end: pos + insert.length },
    };
  }

  // wikilink is handled by the caller (opens the picker).
  if (action === "wikilink") return null;

  return null;
}

/** Insert a `[[Title]]` wikilink at the selection (replacing it). */
export function insertWikilink(text: string, selection: Selection, title: string): FormatResult {
  const { start, end } = normalize(selection, text.length);
  const insert = `[[${title}]]`;
  return {
    text: replaceRange(text, start, end, insert),
    selection: { start: start + insert.length, end: start + insert.length },
  };
}

/** Clamp + order a selection to the current text bounds. */
function normalize(sel: Selection, len: number): Selection {
  let start = Math.max(0, Math.min(sel.start, len));
  let end = Math.max(0, Math.min(sel.end, len));
  if (start > end) [start, end] = [end, start];
  return { start, end };
}
