"use client";

/**
 * TableBlockWidget — a Live Preview block widget that renders a GFM pipe table
 * inline in the editor via the same NoteMarkdownPreview pipeline the read view
 * uses (remark-gfm), so the rendered table matches reading mode. Built on
 * BlockPreviewWidget.
 *
 * Click-to-edit: cursor outside the table → rendered table; cursor inside → raw
 * pipe source (livePreview.ts skips the widget for the active block). A broken
 * table (e.g. a column-count mismatch) simply renders differently, which is the
 * signal that the source needs fixing.
 */

import type { WidgetType } from "@codemirror/view";
import type { ReactNode } from "react";
import { BlockPreviewWidget } from "./block-preview-widget";
import { NoteMarkdownPreview } from "@/components/notes/NoteMarkdownPreview";

export interface TableBlockData {
  /** The raw table source (all its pipe lines). */
  raw: string;
}

/**
 * True when `raw` is a well-formed GFM table: a header row, a delimiter row
 * (`| --- | :--: |`), and at least the two of them. Guards against treating a
 * lone pipe-containing prose line as a table.
 */
export function isTableSource(raw: string): boolean {
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return false;
  const sep = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;
  // The second non-blank line must be the delimiter row.
  return lines[1] !== undefined && sep.test(lines[1]) && lines[0].includes("|");
}

export class TableBlockWidget extends BlockPreviewWidget {
  constructor(private readonly data: TableBlockData) {
    super();
  }

  eq(other: TableBlockWidget): boolean {
    return other.data.raw === this.data.raw;
  }

  protected extraClass(): string {
    return "cm-lp-tableblock";
  }

  protected render(): ReactNode {
    // Trim so stray leading/trailing blank lines can't render as whitespace
    // text nodes that inflate the widget's height.
    return <NoteMarkdownPreview content={this.data.raw.trim()} inline />;
  }
}

/** Convenience factory so livePreview.ts stays free of React imports. */
export function makeTableBlockWidget(raw: string): WidgetType {
  return new TableBlockWidget({ raw });
}
