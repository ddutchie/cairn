"use client";

import React from "react";
import { CodeBlock } from "./CodeBlock";
import { MermaidDiagram } from "./MermaidDiagram";

/**
 * Shared renderer for a ReactMarkdown `pre` element (a fenced code block).
 *
 * Extracts the language from the child `<code>`'s `language-*` class, strips
 * the trailing newline, and routes `mermaid` fences to `MermaidDiagram` and
 * everything else to `CodeBlock`. This exact logic was duplicated in
 * note-editor, NoteMarkdownPreview, and the chat MarkdownContent renderer.
 *
 * Usage in a `components` map: `pre: ({ children }) => renderCodeFence(children)`.
 */
export function renderCodeFence(children: React.ReactNode): React.ReactElement {
  const child = Array.isArray(children) ? children[0] : children;
  const code = child as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
  const className = code?.props?.className ?? "";
  const lang = className.replace("language-", "") || undefined;
  const content = String(code?.props?.children ?? "").replace(/\n$/, "");
  if (lang === "mermaid") return <MermaidDiagram chart={content} />;
  return <CodeBlock code={content} language={lang} />;
}
