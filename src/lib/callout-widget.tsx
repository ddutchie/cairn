"use client";

/**
 * CalloutWidget — a Live Preview block widget that renders an Obsidian-style
 * callout (`> [!note] …`) inline in the editor, reusing the same <Callout>
 * React component the Read-mode preview uses. Built on BlockPreviewWidget, which
 * handles the mount/measure/teardown lifecycle common to all block widgets.
 *
 * Click-to-edit: cursor outside the callout → widget; cursor inside → raw `>`
 * source (livePreview.ts skips the widget for the active block).
 */

import type { WidgetType } from "@codemirror/view";
import type { ReactNode } from "react";
import { BlockPreviewWidget } from "./block-preview-widget";
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

export class CalloutWidget extends BlockPreviewWidget {
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

  protected extraClass(): string {
    return "cm-lp-callout";
  }

  protected render(): ReactNode {
    return (
      <Callout
        type={this.data.type}
        title={this.data.title}
        collapsible={this.data.collapsible}
        defaultOpen={this.data.defaultOpen}
      >
        {this.data.body ? <NoteMarkdownPreview content={this.data.body} /> : null}
      </Callout>
    );
  }
}

/** Convenience factory so livePreview.ts stays free of React imports. */
export function makeCalloutWidget(data: CalloutData): WidgetType {
  return new CalloutWidget(data);
}
