"use client";

/**
 * NoteMarkdownPreview — stateless markdown renderer using the same pipeline
 * as the NoteEditor read mode. Takes a plain `content` string and renders it.
 *
 * Used by AgentEditor to preview .md files without duplicating the plugin stack.
 * No note mutation, no TOC, no scroll-container ref dependency.
 */

import React, { useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { MermaidDiagram } from "./MermaidDiagram";
import { CodeBlock } from "./CodeBlock";
import { Callout } from "./Callout";
import { MathBlock } from "./MathBlock";
import { remarkCallout, remarkObsidianEmbeds, remarkPromoteDisplayMath, makeLatexPlugins, InlineCode } from "@/lib/markdown/pipeline";

// ── NoteMarkdownPreview ───────────────────────────────────────────────────────

interface NoteMarkdownPreviewProps {
  content: string;
  className?: string;
}

export function NoteMarkdownPreview({ content, className }: NoteMarkdownPreviewProps) {
  const { rehypeCaptureLatex, rehypeMergedPass } = useMemo(() => makeLatexPlugins(), []);

  if (!content.trim()) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-[var(--text-tertiary)] p-8">
        Empty file
      </div>
    );
  }

  return (
    <div className={`prose-cairn px-6 py-5 overflow-y-auto h-full ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath, remarkPromoteDisplayMath, remarkCallout, remarkObsidianEmbeds]}
        rehypePlugins={[rehypeCaptureLatex, rehypeKatex, rehypeMergedPass]}
        urlTransform={(url) => url.startsWith("asset://") ? url : defaultUrlTransform(url)}
        components={({
          mark({ children }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
            return (
              <mark className="rounded px-0.5" style={{ background: "color-mix(in srgb, var(--accent) 22%, transparent)", color: "var(--text-primary)" }}>
                {children}
              </mark>
            );
          },
          callout({ children, ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
            const p = props as Record<string, string>;
            return (
              <Callout
                type={p["data-callout-type"] ?? "note"}
                title={p["data-title"] || undefined}
                collapsible={p["data-collapsible"] === "true"}
                defaultOpen={p["data-default-open"] !== "false"}
              >
                {children}
              </Callout>
            );
          },
          mathblock({ children, ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
            return <MathBlock renderedChildren={children} latex={(props as Record<string, string>)["data-latex"] ?? ""} />;
          },
          blockquote({ children }: React.BlockquoteHTMLAttributes<HTMLElement> & ExtraProps) {
            return <blockquote className="border-l-2 border-[var(--border)] pl-4 text-[var(--text-secondary)] my-3">{children}</blockquote>;
          },
          pre({ children }: React.HTMLAttributes<HTMLPreElement> & ExtraProps) {
            const child = Array.isArray(children) ? children[0] : children;
            const code = child as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
            const lang = (code?.props?.className ?? "").replace("language-", "") || undefined;
            const text = String(code?.props?.children ?? "").replace(/\n$/, "");
            if (lang === "mermaid") return <MermaidDiagram chart={text} />;
            return <CodeBlock code={text} language={lang} />;
          },
          code({ className, children }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
            return <InlineCode className={className}>{children}</InlineCode>;
          },
          h1({ children }: React.HTMLAttributes<HTMLHeadingElement> & ExtraProps) { return <h1>{children}</h1>; },
          h2({ children }: React.HTMLAttributes<HTMLHeadingElement> & ExtraProps) { return <h2>{children}</h2>; },
          h3({ children }: React.HTMLAttributes<HTMLHeadingElement> & ExtraProps) { return <h3>{children}</h3>; },
          a({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
            return <a href={href} {...props}>{children}</a>;
          },
          section({ children, ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
            if ((props.className ?? "").includes("footnotes")) {
              return <section {...props} className="footnotes mt-8 pt-4 text-[0.786rem] text-[var(--text-secondary)]" style={{ borderTop: "1px solid var(--border)" }}>{children}</section>;
            }
            return <section {...props}>{children}</section>;
          },
        } as import("react-markdown").Components)}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
