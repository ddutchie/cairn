"use client";

/**
 * MathBlockWidget — a Live Preview block widget that renders a display-math
 * block ($$ … $$) inline in the editor. It renders the raw block through the
 * same NoteMarkdownPreview pipeline the read view uses (remark-math +
 * rehype-katex), so the KaTeX output matches reading mode exactly. Built on
 * BlockPreviewWidget.
 *
 * Click-to-edit: cursor outside the block → rendered math; cursor inside → raw
 * `$$` source (livePreview.ts skips the widget for the active block).
 */

import type { WidgetType } from "@codemirror/view";
import type { ReactNode } from "react";
import { BlockPreviewWidget } from "./block-preview-widget";
import { NoteMarkdownPreview } from "@/components/notes/NoteMarkdownPreview";

export interface MathBlockData {
  /** The raw block including the `$$` fences. */
  raw: string;
}

export class MathBlockWidget extends BlockPreviewWidget {
  constructor(private readonly data: MathBlockData) {
    super();
  }

  eq(other: MathBlockWidget): boolean {
    return other.data.raw === this.data.raw;
  }

  protected extraClass(): string {
    return "cm-lp-mathblock";
  }

  protected render(): ReactNode {
    return <NoteMarkdownPreview content={this.data.raw} className="!py-1" />;
  }
}

/** Convenience factory so livePreview.ts stays free of React imports. */
export function makeMathBlockWidget(raw: string): WidgetType {
  return new MathBlockWidget({ raw });
}
