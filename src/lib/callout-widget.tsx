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
    // Mount the React callout SYNCHRONOUSLY. This is the crux of the cursor-drift
    // fix: CodeMirror measures the widget's height immediately after toDOM()
    // returns, and it uses that height to position every line below it. If React
    // painted asynchronously (a plain createRoot().render()), the container would
    // still be ~0px tall at measure time, so CM placed the cursor several lines
    // off — and no amount of requestMeasure() after the fact fully recovered,
    // because the first (wrong) layout had already mapped click coordinates.
    // flushSync forces the render to commit before we return, so the DOM has its
    // real height the first time CM measures. `estimatedHeight = -1` keeps CM
    // from ever assuming the widget matches the replaced source lines.
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
    // The collapsible header toggles height at runtime (open/closed), which
    // changes the widget's size AFTER the initial synchronous measure. The
    // toggle is a React onClick inside <Callout>; listen on the container (fires
    // for the same click) and re-measure once React has committed the new
    // height — a double rAF waits out that commit. This is only for the toggle
    // transition; initial layout is already correct from the flushSync above.
    if (this.data.collapsible) {
      container.addEventListener("click", () => {
        requestAnimationFrame(() => requestAnimationFrame(() => view.requestMeasure()));
      });
    }
    return container;
  }

  // The rendered callout height differs from the source lines it replaces, so
  // CM must always re-measure rather than assume the widget matches text.
  get estimatedHeight(): number {
    return -1;
  }

  destroy(): void {
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
    // Callout already has my-3; keep the CM line box from adding extra height.
    margin: "0",
  },
});
