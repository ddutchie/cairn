"use client";

/**
 * CodeBlockWidget — a Live Preview block widget that renders a fenced code block
 * (```lang … ```) inline in the editor using the same <CodeBlock> component the
 * Read-mode preview uses (syntax highlighting + copy button). Built on
 * BlockPreviewWidget.
 *
 * Click-to-edit: cursor outside the fence → highlighted widget; cursor inside →
 * raw ``` source (livePreview.ts skips the widget for the active block).
 */

import type { WidgetType } from "@codemirror/view";
import type { ReactNode } from "react";
import { BlockPreviewWidget } from "./block-preview-widget";
import { CodeBlock } from "@/components/notes/CodeBlock";

export interface CodeBlockData {
  language: string;
  code: string;
}

/**
 * Parse the raw source of a fenced code block into { language, code }.
 * `raw` is the full block including the opening/closing fence lines. Returns
 * null if it isn't a well-formed fence. Supports ``` and ~~~ fences, and an
 * info string after the opening fence (only the first token is the language).
 */
export function parseFencedCode(raw: string): CodeBlockData | null {
  const lines = raw.split("\n");
  if (lines.length < 1) return null;
  const open = lines[0].match(/^(\s*)(`{3,}|~{3,})\s*([^\s`~]*)/);
  if (!open) return null;
  const fence = open[2][0]; // ` or ~
  // Body = everything between the opening fence and the closing fence (a line
  // that is only the same fence char, >= 3). If no closing fence (block still
  // being typed), take the rest.
  const body: string[] = [];
  let closed = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (new RegExp(`^\\s*${fence === "`" ? "`" : "~"}{3,}\\s*$`).test(line)) {
      closed = true;
      break;
    }
    body.push(line);
  }
  // A block that has no body AND no close is just an opening fence being typed —
  // let it stay raw (return null so no widget renders yet).
  if (!closed && body.length === 0) return null;
  return { language: open[3] || "", code: body.join("\n") };
}

export class CodeBlockWidget extends BlockPreviewWidget {
  constructor(private readonly data: CodeBlockData) {
    super();
  }

  eq(other: CodeBlockWidget): boolean {
    return other.data.language === this.data.language && other.data.code === this.data.code;
  }

  protected extraClass(): string {
    return "cm-lp-codeblock";
  }

  protected render(): ReactNode {
    return <CodeBlock code={this.data.code} language={this.data.language || undefined} />;
  }
}

/** Convenience factory so livePreview.ts stays free of React imports. */
export function makeCodeBlockWidget(data: CodeBlockData): WidgetType {
  return new CodeBlockWidget(data);
}
