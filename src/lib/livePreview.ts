"use client";

/**
 * livePreview — CodeMirror 6 extension that hides markdown syntax markers on
 * every line EXCEPT the one(s) the cursor/selection currently touch.
 *
 * The effect: `**bold**` shows as **bold**, `# Heading` shows as a bare heading,
 * `- item` shows as a "•" bullet — until you click into that line, at which
 * point the raw markers reappear so they're directly editable.
 *
 * This is the "Live Preview" experience (à la Obsidian) built directly on the
 * existing editor, so nothing else (wikilinks, paste-upload, AI toolbar, undo
 * history, changed-line highlights) is affected. The document text is never
 * mutated — only the *rendering* is decorated. Raw markdown stays on disk.
 */

import { EditorState, Range } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

// ── Widgets ────────────────────────────────────────────────────────────────

/** Renders a "•" in place of a "-"/"*"/"+" list bullet marker. */
class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.textContent = "•";
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

const bulletWidget = new BulletWidget();

// A zero-width replacement used to hide a marker completely.
const hideMark = Decoration.replace({});
const hideBulletMark = Decoration.replace({ widget: bulletWidget });

// Inline mark decorations (add a class to a text range without hiding it).
// Styled by livePreviewTheme below to match the Read-mode renderers.
const highlightMark = Decoration.mark({ class: "cm-lp-highlight" });
const wikilinkMark = Decoration.mark({ class: "cm-lp-wikilink" });
// Line decoration for blockquotes — draws the left border like Read mode.
const blockquoteLine = Decoration.line({ class: "cm-lp-blockquote" });

// Regexes for the marker-based features. `==…==` highlight and `[[…]]`
// wikilinks aren't distinct nodes in the base markdown grammar, so we scan
// text directly (mirrors the remark/rehype passes used by the Read renderer).
const HIGHLIGHT_RE = /==([^=\n]+?)==/g;
const WIKILINK_RE = /\[\[([^\][\n]+?)\]\]/g;

// Node types (from @lezer/markdown) whose leading/enclosing marks we hide.
// We match on the mark child node names the parser emits.
const HIDDEN_MARK_NODES = new Set<string>([
  "HeaderMark", // the "#" run (+ following space handled by trimming)
  "EmphasisMark", // "*" or "_"
  "StrikethroughMark", // "~~"
  "CodeMark", // "`" for inline code
  "QuoteMark", // ">"
]);

// ── Range helpers ────────────────────────────────────────────────────────────

/** Returns the set of line numbers (1-indexed) touched by any selection range. */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const fromLine = state.doc.lineAt(range.from).number;
    const toLine = state.doc.lineAt(range.to).number;
    for (let n = fromLine; n <= toLine; n++) lines.add(n);
  }
  return lines;
}

// ── Decoration builder ───────────────────────────────────────────────────────

function buildDecorations(view: EditorView): DecorationSet {
  const active = activeLines(view.state);
  // `replaceDecos` hide/replace text and must never overlap each other.
  // `otherDecos` are mark (inline styling) + line decorations, which may
  // coexist with replaces and with each other.
  const replaceDecos: Range<Decoration>[] = [];
  const otherDecos: Range<Decoration>[] = [];
  const { doc } = view.state;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        if (!HIDDEN_MARK_NODES.has(name)) return;

        // Skip if this mark sits on a line the user is editing.
        const line = doc.lineAt(node.from).number;
        if (active.has(line)) return;

        if (name === "HeaderMark" || name === "QuoteMark") {
          // Hide the mark AND the single trailing space so the heading/quote
          // text starts at the margin.
          let end = node.to;
          if (doc.sliceString(end, end + 1) === " ") end += 1;
          replaceDecos.push(hideMark.range(node.from, end));
          return;
        }

        // Emphasis / strikethrough / inline-code marks: hide the delimiter run.
        replaceDecos.push(hideMark.range(node.from, node.to));
      },
    });

    // Blockquotes: draw the Read-mode left border on each quote line. The
    // Blockquote node spans all its lines; decorate each line start.
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Blockquote") return;
        const startLine = doc.lineAt(node.from).number;
        const endLine = doc.lineAt(Math.min(node.to, doc.length)).number;
        for (let ln = startLine; ln <= endLine; ln++) {
          const line = doc.line(ln);
          otherDecos.push(blockquoteLine.range(line.from));
        }
      },
    });

    // Links: collapse `[text](url)` to just its display text. We hide the
    // leading "[", and everything from the closing "]" through the ")".
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Link") return;
        const line = doc.lineAt(node.from).number;
        if (active.has(line)) return;
        const text = doc.sliceString(node.from, node.to);
        // Match [display](target) — hide "[" and "](target)".
        const m = /^\[([^\]]*)\]\(/.exec(text);
        if (!m) return;
        const openBracketEnd = node.from + 1; // after "["
        const closeBracketStart = node.from + 1 + m[1].length; // at "]"
        replaceDecos.push(hideMark.range(node.from, openBracketEnd)); // hide "["
        replaceDecos.push(hideMark.range(closeBracketStart, node.to)); // hide "](url)"
      },
    });

    // List bullets: the markdown parser emits "ListMark" for "-", "*", "+", and
    // ordered "1." markers. We render unordered bullets as "•" and leave
    // ordered markers visible (numbers are meaningful to read).
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "ListMark") return;
        const line = doc.lineAt(node.from).number;
        if (active.has(line)) return;
        const text = doc.sliceString(node.from, node.to);
        if (text === "-" || text === "*" || text === "+") {
          replaceDecos.push(hideBulletMark.range(node.from, node.to));
        }
      },
    });

    // Highlight (`==text==`) and wikilinks (`[[Title]]`) — scanned via regex on
    // the visible text since neither is a distinct node in the base grammar.
    scanInlinePatterns(view, from, to, active, replaceDecos, otherDecos);
  }

  // RangeSet requires ascending, non-overlapping ranges sorted by `from`.
  replaceDecos.sort((a, b) => a.from - b.from || a.to - b.to);
  // Drop any replace range that overlaps the previous one — a link's hidden
  // brackets can collide with an inline mark hidden inside its text. Keeping
  // the first (outer) range is safe; the dropped inner mark stays visible.
  const nonOverlapping: Range<Decoration>[] = [];
  let lastTo = -1;
  for (const w of replaceDecos) {
    if (w.from < lastTo) continue;
    nonOverlapping.push(w);
    lastTo = w.to;
  }
  // Merge replace + mark/line decorations. CodeMirror sorts internally when we
  // pass `sort: true`; line/mark decorations coexist with replaces.
  return Decoration.set([...nonOverlapping, ...otherDecos], true);
}

// ── Inline regex patterns (highlight + wikilinks) ────────────────────────────

function scanInlinePatterns(
  view: EditorView,
  from: number,
  to: number,
  active: Set<number>,
  replaceDecos: Range<Decoration>[],
  otherDecos: Range<Decoration>[],
): void {
  const { doc } = view.state;
  const text = doc.sliceString(from, to);

  // `==highlight==`
  HIGHLIGHT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HIGHLIGHT_RE.exec(text)) !== null) {
    const start = from + m.index;
    const end = start + m[0].length;
    // Always style the inner text; only hide the "==" markers off-active-line.
    const innerFrom = start + 2;
    const innerTo = end - 2;
    otherDecos.push(highlightMark.range(innerFrom, innerTo));
    if (!active.has(doc.lineAt(start).number)) {
      replaceDecos.push(hideMark.range(start, innerFrom)); // leading "=="
      replaceDecos.push(hideMark.range(innerTo, end)); // trailing "=="
    }
  }

  // `[[Wikilink]]`
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const start = from + m.index;
    const end = start + m[0].length;
    const innerFrom = start + 2;
    const innerTo = end - 2;
    otherDecos.push(wikilinkMark.range(innerFrom, innerTo));
    if (!active.has(doc.lineAt(start).number)) {
      replaceDecos.push(hideMark.range(start, innerFrom)); // leading "[["
      replaceDecos.push(hideMark.range(innerTo, end)); // trailing "]]"
    }
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      // Rebuild on any doc change, selection move, or viewport scroll — all can
      // change which lines are "active" or which marks are visible.
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

// Styling for the bullet widget. Kept as a theme so it travels with the
// extension and picks up Cairn CSS variables.
const livePreviewTheme = EditorView.theme({
  ".cm-lp-bullet": {
    color: "var(--accent)",
    // Match the width a "- " would occupy so text doesn't shift when the
    // cursor enters/leaves the line and the raw marker returns.
    display: "inline-block",
    width: "1ch",
  },
  // `==highlight==` — matches the Read-mode <mark> (22% accent tint).
  ".cm-lp-highlight": {
    background: "color-mix(in srgb, var(--accent) 22%, transparent)",
    borderRadius: "0.25rem",
    padding: "0 0.125rem",
    color: "var(--text-primary)",
  },
  // `[[Wikilink]]` — matches the resolved wikilink chip (10% accent tint,
  // accent text). Resolution status (resolved vs. missing) is a Read-mode
  // concern; in the editor we always show the resolved styling.
  ".cm-lp-wikilink": {
    color: "var(--accent)",
    background: "color-mix(in srgb, var(--accent) 10%, transparent)",
    borderRadius: "0.375rem",
    padding: "0.05em 0.35em",
    fontWeight: "500",
  },
  // Blockquote left border — matches the Read-mode component override
  // (2px solid var(--border), 1rem left padding, secondary text colour).
  ".cm-lp-blockquote": {
    borderLeft: "2px solid var(--border)",
    paddingLeft: "1rem",
    color: "var(--text-secondary)",
  },
});

/**
 * Live Preview extension. Add to the editor's extension array. Reversible via a
 * Compartment if you want to toggle it at runtime.
 */
export function livePreview() {
  return [livePreviewPlugin, livePreviewTheme];
}
