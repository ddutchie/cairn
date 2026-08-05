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

import { EditorState, EditorSelection, Prec, Range, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  keymap,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { makeCalloutWidget, parseCalloutSource } from "./callout-widget";
import { makeCodeBlockWidget, parseFencedCode } from "./code-block-widget";
import { makeMathBlockWidget } from "./math-block-widget";
import { makeTableBlockWidget, isTableSource } from "./table-block-widget";
import { blockWidgetTheme } from "./block-preview-widget";

// Master kill-switch for Tier 2 inline block widgets (callouts + fenced code
// blocks; tables/mermaid/math later). Block widgets are the finicky part
// (height measurement, cursor enter/exit), so this stays as an escape hatch.
// When false: callouts render as ordinary blockquotes (Tier 1 border) and code
// fences stay raw — the block StateField/widgets/keymap are not added.
const BLOCK_WIDGETS_ENABLED = true;

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

// ── Callout block widgets (StateField) ───────────────────────────────────────
// Block-level replace decorations MUST be supplied via a StateField, not a
// ViewPlugin (CodeMirror throws "Block decorations may not be specified via
// plugins"). So callouts get their own field; the inline decorations stay in
// the ViewPlugin below. Both share `findCalloutBlocks` so the inline passes can
// skip lines a widget covers.

interface BlockRange {
  from: number;
  to: number;
  lineStart: number;
  lineEnd: number;
}

/** A detected block-widget candidate: its range plus a factory for its widget. */
interface BlockWidget extends BlockRange {
  makeWidget: () => WidgetType;
}

/**
 * Find every block that should render as an inline widget (callouts, fenced code
 * incl. mermaid, GFM tables, and $$ math), each with its char/line range and a
 * widget factory. All kinds share the same StateField + click-to-edit
 * machinery; adding a new block type means adding another branch here.
 *
 * Result is cached per EditorState (WeakMap): within one update cycle the
 * StateField (decorations), the ViewPlugin (blockWidgetLineSet), and the arrow
 * keymap all ask for the same computation, which otherwise means 2–3 full
 * syntax-tree scans per keystroke. EditorStates are immutable and short-lived,
 * so instance-keyed caching is safe and self-evicting.
 */
const blockWidgetCache = new WeakMap<EditorState, BlockWidget[]>();
function findBlockWidgets(state: EditorState): BlockWidget[] {
  const cached = blockWidgetCache.get(state);
  if (cached) return cached;
  const result = computeBlockWidgets(state);
  blockWidgetCache.set(state, result);
  return result;
}

function computeBlockWidgets(state: EditorState): BlockWidget[] {
  const { doc } = state;
  const out: BlockWidget[] = [];
  // Push a block spanning whole lines. `blockLineCount`, when given, clamps the
  // range to that many lines from `from` — used to trim a callout/blockquote or
  // table whose lezer node over-extends into a following paragraph when there's
  // no blank line between them (otherwise the widget would swallow that text).
  const push = (from: number, toRaw: number, makeWidget: () => WidgetType, blockLineCount?: number) => {
    const lineStart = doc.lineAt(from).number;
    let lineEnd = doc.lineAt(Math.min(toRaw, doc.length)).number;
    if (blockLineCount != null) lineEnd = Math.min(lineEnd, lineStart + blockLineCount - 1);
    out.push({
      from: doc.line(lineStart).from,
      to: doc.line(lineEnd).to,
      lineStart,
      lineEnd,
      makeWidget,
    });
  };
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "Blockquote") {
        // Skip a blockquote nested inside another blockquote: a nested callout
        // would emit overlapping block ranges, which throw when added to a
        // Decoration.set(sorted). Only the outermost becomes a callout widget.
        if (node.node.parent?.name === "Blockquote") return;
        const nodeTo = Math.min(node.to, doc.length);
        const raw = doc.sliceString(node.from, nodeTo);
        const data = parseCalloutSource(raw);
        if (!data) return;
        // A blockquote directly followed by a paragraph (no blank line) can have
        // its node range extend past the `>` lines. Count the actual leading
        // `>` lines so the widget covers only the callout, not the next para.
        const quoteLines = countLeadingQuoteLines(raw);
        push(node.from, nodeTo, () => makeCalloutWidget(data), quoteLines);
      } else if (node.name === "FencedCode") {
        const nodeTo = Math.min(node.to, doc.length);
        const raw = doc.sliceString(node.from, nodeTo);
        const data = parseFencedCode(raw);
        if (!data) return;
        push(node.from, nodeTo, () => makeCodeBlockWidget(data));
      } else if (node.name === "Table") {
        const nodeTo = Math.min(node.to, doc.length);
        const raw = doc.sliceString(node.from, nodeTo);
        if (!isTableSource(raw)) return;
        push(node.from, nodeTo, () => makeTableBlockWidget(raw));
      }
    },
  });
  // $$ … $$ display-math isn't a distinct node in the base grammar (it lands in
  // a Paragraph), so scan for delimiter pairs separately.
  for (const m of findMathBlocks(doc)) {
    push(m.from, m.to, () => makeMathBlockWidget(doc.sliceString(m.from, m.to)));
  }
  return out;
}

/** Count the leading contiguous `>` blockquote lines in a raw block. */
function countLeadingQuoteLines(raw: string): number {
  const lines = raw.split("\n");
  let n = 0;
  for (const l of lines) {
    if (/^\s*>/.test(l)) n++;
    else break;
  }
  return n || lines.length;
}

/** Find $$ … $$ display-math blocks (char ranges) by scanning delimiter pairs. */
function findMathBlocks(doc: EditorState["doc"]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let openLine = -1;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (line.text.trim() !== "$$") continue;
    if (openLine === -1) {
      openLine = i;
    } else {
      out.push({ from: doc.line(openLine).from, to: line.to });
      openLine = -1;
    }
  }
  return out;
}

/** Line numbers covered by a block widget (cursor outside) — used by the
 *  inline ViewPlugin to skip those lines. */
function blockWidgetLineSet(state: EditorState): Set<number> {
  const set = new Set<number>();
  if (!BLOCK_WIDGETS_ENABLED) return set; // feature disabled → treat blocks as plain
  const active = activeLines(state);
  for (const block of findBlockWidgets(state)) {
    let cursorInside = false;
    for (let ln = block.lineStart; ln <= block.lineEnd; ln++) {
      if (active.has(ln)) { cursorInside = true; break; }
    }
    if (cursorInside) continue;
    for (let ln = block.lineStart; ln <= block.lineEnd; ln++) set.add(ln);
  }
  return set;
}

const blockWidgetField = StateField.define<DecorationSet>({
  create(state) {
    return buildBlockWidgetDecorations(state);
  },
  update(deco, tr) {
    if (tr.docChanged || tr.selection) return buildBlockWidgetDecorations(tr.state);
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function buildBlockWidgetDecorations(state: EditorState): DecorationSet {
  const active = activeLines(state);
  const decos: Range<Decoration>[] = [];
  // Sort by start so overlapping candidates can be dropped deterministically —
  // block replace decorations must never overlap or Decoration.set throws.
  const blocks = findBlockWidgets(state).sort((a, b) => a.from - b.from);
  let lastTo = -1;
  for (const block of blocks) {
    if (block.from < lastTo) continue; // overlaps a kept block — skip defensively
    let cursorInside = false;
    for (let ln = block.lineStart; ln <= block.lineEnd; ln++) {
      if (active.has(ln)) { cursorInside = true; break; }
    }
    // Even when the cursor is inside (widget hidden), advance lastTo so a later
    // overlapping candidate is still dropped.
    lastTo = Math.max(lastTo, block.to);
    if (cursorInside) continue; // show raw source for editing
    decos.push(
      Decoration.replace({ widget: block.makeWidget(), block: true }).range(block.from, block.to),
    );
  }
  return Decoration.set(decos, true);
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

  // Lines covered by a callout widget (from the StateField) — the inline passes
  // below skip these so we don't emit decorations that overlap the block
  // widget's replaced range.
  const blockWidgetLines = blockWidgetLineSet(view.state);
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
        // Skip marks inside a callout that's being widget-replaced.
        if (blockWidgetLines.has(line)) return;

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

    // Blockquotes: draw the Read-mode left border on each quote line. Skip
    // callout blockquotes handled by the widget above.
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Blockquote") return;
        const startLine = doc.lineAt(node.from).number;
        const endLine = doc.lineAt(Math.min(node.to, doc.length)).number;
        for (let ln = startLine; ln <= endLine; ln++) {
          if (blockWidgetLines.has(ln)) continue;
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
        if (blockWidgetLines.has(line)) return;
        const text = doc.sliceString(node.from, node.to);
        if (text === "-" || text === "*" || text === "+") {
          replaceDecos.push(hideBulletMark.range(node.from, node.to));
        }
      },
    });

    // Highlight (`==text==`) and wikilinks (`[[Title]]`) — scanned via regex on
    // the visible text since neither is a distinct node in the base grammar.
    scanInlinePatterns(view, from, to, active, blockWidgetLines, replaceDecos, otherDecos);
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
  // pass `sort: true`; line/mark decorations coexist with replaces. Block
  // (callout) decorations are provided separately by `calloutField`.
  return Decoration.set([...nonOverlapping, ...otherDecos], true);
}

// ── Inline regex patterns (highlight + wikilinks) ────────────────────────────

function scanInlinePatterns(
  view: EditorView,
  from: number,
  to: number,
  active: Set<number>,
  blockWidgetLines: Set<number>,
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
    if (blockWidgetLines.has(doc.lineAt(start).number)) continue;
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
    if (blockWidgetLines.has(doc.lineAt(start).number)) continue;
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
 * Vertical-cursor motion across a folded block widget (callout or code block).
 *
 * A `block: true` replace decoration is one atomic unit, so CodeMirror's default
 * ArrowUp/ArrowDown jumps clean OVER the whole widget — the selection never
 * lands on a line inside it, so the "cursor inside → show raw source" unfold
 * (driven by `activeLines`) never fires and the widget appears un-enterable.
 *
 * These handlers make a vertical move that would cross a folded widget instead
 * land the cursor at the widget's first line, which unfolds it for editing — so
 * the widget behaves like the text it stands in for. Moving again from inside
 * the (now unfolded) block advances normally, because it's no longer folded.
 *
 * Only acts on a single collapsed cursor entering a FOLDED block from the
 * adjacent line; every other case (selections, cursor already inside, no
 * adjacent block) falls through to CM's default handling by returning false.
 */
export function foldedBlockFromCursor(state: EditorState, dir: 1 | -1): BlockRange | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const curLine = state.doc.lineAt(sel.head).number;
  const active = activeLines(state);
  for (const block of findBlockWidgets(state)) {
    // A block the cursor is already inside is unfolded — let CM move normally.
    let inside = false;
    for (let ln = block.lineStart; ln <= block.lineEnd; ln++) {
      if (active.has(ln)) { inside = true; break; }
    }
    if (inside) continue;
    // Entering from the line directly above (moving down) or below (moving up).
    if (dir === 1 && curLine === block.lineStart - 1) return block;
    if (dir === -1 && curLine === block.lineEnd + 1) return block;
  }
  return null;
}

function moveIntoBlock(view: EditorView, dir: 1 | -1): boolean {
  const block = foldedBlockFromCursor(view.state, dir);
  if (!block) return false;
  // Land on the block's NEAR edge for natural vertical motion: moving down
  // enters at its first line, moving up enters at its last line. Either way the
  // cursor is inside the block's range, so activeLines unfolds it.
  const targetLine = dir === -1 ? block.lineEnd : block.lineStart;
  const target = view.state.doc.line(targetLine).from;
  view.dispatch({
    selection: EditorSelection.cursor(target),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

const blockWidgetKeymap = Prec.high(
  keymap.of([
    { key: "ArrowDown", run: (v) => moveIntoBlock(v, 1) },
    { key: "ArrowUp", run: (v) => moveIntoBlock(v, -1) },
  ]),
);

/**
 * Live Preview extension. Add to the editor's extension array. Reversible via a
 * Compartment if you want to toggle it at runtime.
 */
export function livePreview() {
  const exts = [livePreviewPlugin, livePreviewTheme];
  if (BLOCK_WIDGETS_ENABLED) exts.unshift(blockWidgetField, blockWidgetTheme, blockWidgetKeymap);
  return exts;
}
