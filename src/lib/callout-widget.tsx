"use client";

/**
 * CalloutWidget — a CodeMirror block widget that renders an Obsidian-style
 * callout (`> [!note] …`) inline in the editor, reusing the same <Callout>
 * React component the Read-mode preview uses.
 *
 * This is the "click-to-edit" Tier 2 approach: the widget is a read-only
 * rendering. When the cursor enters the callout's source range the livePreview
 * extension skips the widget entirely and shows the raw `>` lines, so editing
 * happens on plain markdown. No edit-round-trip inside the widget is needed.
 */

import { EditorView, WidgetType } from "@codemirror/view";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Callout, parseCalloutDirective } from "@/components/notes/Callout";
import { NoteMarkdownPreview } from "@/components/notes/NoteMarkdownPreview";

export interface CalloutData {
  type: string;
  title: string;
  collapsible: boolean;
  defaultOpen: boolean;
  /** The callout body markdown (blockquote lines with `>` prefixes stripped). */
  body: string;
}

/**
 * Parse the raw source of a callout blockquote into structured data.
 * `raw` is the full multi-line `> …` block. Returns null if the first line is
 * not a `[!type]` directive.
 */
export function parseCalloutSource(raw: string): CalloutData | null {
  const lines = raw.split("\n");
  // Strip a single leading "> " (or ">") from each blockquote line.
  const stripped = lines.map((l) => l.replace(/^>\s?/, ""));
  const directive = parseCalloutDirective(stripped[0] ?? "");
  if (!directive) return null;
  const body = stripped.slice(1).join("\n").trim();
  return { ...directive, body };
}

export class CalloutWidget extends WidgetType {
  private root: Root | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly data: CalloutData) {
    super();
  }

  // Reuse the same DOM when the callout source is unchanged — avoids tearing
  // down and re-mounting the React root on unrelated keystrokes.
  eq(other: CalloutWidget): boolean {
    return (
      other.data.type === this.data.type &&
      other.data.title === this.data.title &&
      other.data.collapsible === this.data.collapsible &&
      other.data.defaultOpen === this.data.defaultOpen &&
      other.data.body === this.data.body
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-lp-callout";
    // Mount the React callout SYNCHRONOUSLY so CodeMirror's first height measure
    // (which happens right after toDOM returns, and positions every line below)
    // sees real content rather than a 0px shell.
    this.root = createRoot(container);
    flushSync(() => {
      this.root?.render(
        <Callout
          type={this.data.type}
          title={this.data.title}
          collapsible={this.data.collapsible}
          defaultOpen={this.data.defaultOpen}
        >
          {this.data.body ? <NoteMarkdownPreview content={this.data.body} /> : null}
        </Callout>,
      );
    });
    // flushSync commits the React tree, but the widget's height keeps changing
    // AFTER that first measure: NoteMarkdownPreview resolves images/embeds in a
    // useEffect, fonts finish loading, and the collapsible header toggles open/
    // closed. Any of these shifts the height CM already committed, which is what
    // desyncs clicks/cursor from the lines below. A ResizeObserver tells CM to
    // re-measure on every size change, so the layout self-corrects once the
    // content settles instead of being frozen at the (often wrong) first height.
    let lastHeight = -1;
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver((entries) => {
        const h = entries[0]?.contentRect.height ?? 0;
        if (h === lastHeight) return; // ignore width-only / no-op notifications
        lastHeight = h;
        view.requestMeasure();
      });
      this.resizeObserver.observe(container);
    }
    return container;
  }

  // The rendered callout height differs from the source lines it replaces, so
  // CM must always re-measure rather than assume the widget matches text.
  get estimatedHeight(): number {
    return -1;
  }

  destroy(): void {
    // Stop observing before unmount so a teardown-time resize can't queue a
    // measure against a destroyed widget.
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    // Unmount asynchronously — React forbids unmounting synchronously from
    // within a render/commit cycle, which CM's DOM updates can be inside of.
    const root = this.root;
    this.root = null;
    if (root) queueMicrotask(() => root.unmount());
  }

  // Let clicks fall through to CodeMirror so clicking the callout places the
  // cursor into its source range (which then reveals the raw markdown for
  // editing). The collapsible header's own React onClick still fires on the
  // way through. Returning true here would swallow the click and make the
  // callout un-selectable ("can't click in").
  ignoreEvent(): boolean {
    return false;
  }
}

/** Convenience factory so livePreview.ts stays free of React imports. */
export function makeCalloutWidget(data: CalloutData): WidgetType {
  return new CalloutWidget(data);
}

// Theme for the widget container. The <Callout> component brings its own
// styling; this only manages block spacing so it sits like a paragraph.
export const calloutWidgetTheme = EditorView.theme({
  ".cm-lp-callout": {
    margin: "0",
    // CRITICAL for correct cursor/click mapping: <Callout> has `my-3` (top+
    // bottom margins). Without a block formatting context those child margins
    // COLLAPSE THROUGH this container, so its border-box height (what CM and the
    // ResizeObserver measure) is ~24px shorter than the space it actually paints.
    // CM then lays out the lines below at the short height while the browser
    // paints the callout taller — so clicks/cursor land a line or two too low.
    // `flow-root` contains the child margins inside the measured box, making the
    // measured height match the painted height. (overflow:hidden would also work
    // but risks clipping; flow-root is the intent-revealing choice.)
    display: "flow-root",
  },
});
