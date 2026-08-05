"use client";

/**
 * BlockPreviewWidget — shared base for Live Preview "Tier 2" block widgets that
 * render a read-only React preview of a markdown block inline in the CodeMirror
 * editor (callouts, code blocks, and later tables/mermaid/math).
 *
 * It bakes in the three hard-won lessons from the callout POC (see the note
 * "Live Preview Editor — Tier 2 Block Widgets"), so each new widget type only
 * has to supply its own React element and an equality check:
 *
 *  1. A `ResizeObserver` that calls `view.requestMeasure()` on mount and when
 *     the height settles later (async syntax/markdown/image resolution, fonts,
 *     toggles) — so CodeMirror positions the lines below at the real height.
 *     (We can't measure synchronously via flushSync: CM calls toDOM from inside
 *     React commits, where flushSync is illegal.)
 *  2. `estimatedHeight = -1` (never assume the widget matches the replaced
 *     source lines), `ignoreEvent() = false` (let clicks fall through so the
 *     cursor enters the source range and the block unfolds to raw markdown),
 *     and a `display: flow-root` container so child margins are contained in
 *     the measured box (otherwise they collapse through and the measured height
 *     is short, drifting the cursor below).
 *
 * The "click-to-edit" model means no edit round-trip inside the widget: when the
 * cursor enters the block's source range, livePreview.ts skips the widget and
 * shows the raw markdown lines for editing.
 */

import { EditorView, WidgetType } from "@codemirror/view";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";

/** Shared container class; styled by blockWidgetTheme (flow-root + no margin). */
export const BLOCK_WIDGET_CLASS = "cm-lp-block";

export abstract class BlockPreviewWidget extends WidgetType {
  private root: Root | null = null;
  private resizeObserver: ResizeObserver | null = null;

  /** The React element to render inside the widget container. */
  protected abstract render(): ReactNode;

  /** Extra class(es) for the container (e.g. "cm-lp-callout") for theming. */
  protected extraClass(): string {
    return "";
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("div");
    container.className = `${BLOCK_WIDGET_CLASS} ${this.extraClass()}`.trim();
    this.root = createRoot(container);
    // Render asynchronously (flushSync is illegal here — CM calls toDOM from
    // inside React commits). Correct height comes from re-measuring once the
    // content has actually laid out.
    this.root.render(this.render());
    // Re-measure once the content lays out: CM measures the widget's height when
    // the block is laid out, which can be before React has painted the (async)
    // content. The ResizeObserver fires on first observe and on every later size
    // change (fonts, images, collapsible toggles), asking CM to re-read it.
    let lastHeight = -1;
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver((entries) => {
        const h = entries[0]?.contentRect.height ?? 0;
        if (h === lastHeight) return; // ignore width-only / no-op notifications
        lastHeight = h;
        view.requestMeasure();
      });
      this.resizeObserver.observe(container);
    } else {
      queueMicrotask(() => view.requestMeasure());
    }
    return container;
  }

  // (3a) The rendered block's height differs from the source lines it replaces.
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

  // (3b) Let clicks fall through so the cursor enters the source range (which
  // reveals raw markdown for editing). Returning true would swallow the click
  // and make the block un-selectable ("can't click in").
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Theme for the shared block-widget container. Each widget's own React component
 * brings its styling; this only manages block spacing + a block formatting
 * context so child margins are contained in the measured box (see lesson 3).
 */
export const blockWidgetTheme = EditorView.theme({
  [`.${BLOCK_WIDGET_CLASS}`]: {
    margin: "0",
    // CRITICAL for correct cursor/click mapping: child components have vertical
    // margins (e.g. <Callout> has `my-3`). Without a block formatting context
    // those margins COLLAPSE THROUGH this container, so its measured border-box
    // height is shorter than the space it actually paints — CM then lays out the
    // lines below at the short height and clicks/cursor land too low. `flow-root`
    // contains the child margins inside the measured box.
    display: "flow-root",
    // CRITICAL: the widget lives inside `.cm-content.cm-lineWrapping`, which CM
    // styles `white-space: pre-wrap`. That's inherited here, so the structural
    // newlines rehypeRaw leaves as text nodes between blocks would render as
    // real blank lines — a huge phantom gap above a table/callout. Reset to
    // normal so inter-block whitespace collapses the way it does in read mode.
    whiteSpace: "normal",
  },
});
