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
import type { Root as MdastRoot, Blockquote, Paragraph, Text as MdastText } from "mdast";
import type { InlineMath } from "mdast-util-math";
import type { Root, Element, Text, ElementContent, Parent } from "hast";
import { visit, SKIP } from "unist-util-visit";
import { MermaidDiagram } from "./MermaidDiagram";
import { CodeBlock } from "./CodeBlock";
import { Callout } from "./Callout";
import { MathBlock } from "./MathBlock";

// ── Remark plugins (shared with note-editor) ──────────────────────────────────

const CALLOUT_RE = /^\[!([^\]]+)\]([\+\-]?)([\s\S]*)/;

const remarkCallout = () => (tree: MdastRoot) => {
  visit(tree, "blockquote", (node: Blockquote) => {
    const first = node.children[0] as Paragraph | undefined;
    const firstText = first?.children?.[0] as MdastText | undefined;
    if (!firstText || firstText.type !== "text") return;
    const match = CALLOUT_RE.exec(firstText.value);
    if (!match) return;
    const [, type, foldMark, rest] = match;
    const collapsible = foldMark === "+" || foldMark === "-";
    const defaultOpen = foldMark !== "-";
    const titleText = rest.trim().split("\n")[0].trim();
    if (rest.trim()) {
      firstText.value = rest.trim().replace(/^[^\n]*\n?/, "");
      if (!firstText.value) first!.children.shift();
    } else {
      node.children.shift();
    }
    node.data = node.data ?? {};
    node.data.hName = "callout";
    node.data.hProperties = {
      "data-callout-type": type.toLowerCase(),
      "data-title": titleText || type,
      "data-collapsible": String(collapsible),
      "data-default-open": String(defaultOpen),
    };
  });
};

const remarkPromoteDisplayMath = () => (tree: MdastRoot) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  visit(tree as any, "paragraph", (node: Paragraph, index: number | undefined, parent: MdastRoot | undefined) => {
    if (!parent || index === undefined) return;
    if (node.children.length !== 1) return;
    const child = node.children[0] as InlineMath | undefined;
    if (child?.type !== "inlineMath") return;
    (parent as MdastRoot).children.splice(index, 1, {
      type: "math",
      value: child.value,
      data: { hName: "div", hProperties: { className: ["math", "math-display"] } },
    } as unknown as MdastRoot["children"][number]);
  });
};

function makeLatexPlugins() {
  const latexBlocks: string[] = [];

  const rehypeCaptureLatex = () => (tree: Root) => {
    latexBlocks.length = 0;
    visit(tree, "element", (node: Element) => {
      const cls = (node.properties?.className as string[] | undefined) ?? [];
      if (cls.includes("math-display")) {
        const text = (node.children[0] as Text | undefined)?.value ?? "";
        latexBlocks.push(text);
      }
    });
  };

  const rehypeMergedPass = () => (tree: Root) => {
    let i = 0;
    visit(tree, (node, index: number | undefined, parent: Parent | undefined) => {
      if (node.type === "element") {
        const cls = ((node as Element).properties?.className as string[] | undefined) ?? [];
        if (cls.includes("katex-display")) {
          if (latexBlocks[i] !== undefined) {
            (node as Element).tagName = "mathblock";
            (node as Element).properties = { "data-latex": latexBlocks[i++] };
          }
          return SKIP;
        }
      }
      if (
        node.type === "text" &&
        (node as Text).value.includes("==") &&
        parent &&
        index !== undefined
      ) {
        const text = (node as Text).value;
        const parts = text.split(/(==.+?==)/g);
        if (parts.length > 1) {
          const nodes: ElementContent[] = parts
            .map((part): ElementContent | null => {
              if (part.startsWith("==") && part.endsWith("==") && part.length > 4) {
                return { type: "element", tagName: "mark", properties: {}, children: [{ type: "text", value: part.slice(2, -2) }] } as Element;
              }
              if (part === "") return null;
              return { type: "text", value: part } as Text;
            })
            .filter((n): n is ElementContent => n !== null);
          (parent as Parent).children.splice(index, 1, ...nodes);
          return index;
        }
      }
    });
  };

  return { rehypeCaptureLatex, rehypeMergedPass };
}

// ── InlineCode ────────────────────────────────────────────────────────────────

const COLOR_RE = /^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(rgba?|hsla?)\s*\([^)]+\))$/i;

function InlineCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  if (className?.startsWith("language-")) return <>{children}</>;
  const text = String(children ?? "").trim();
  const isColor = COLOR_RE.test(text);
  return (
    <code className="px-1 py-0.5 rounded bg-[var(--surface-3)] font-mono text-[0.786rem] text-[var(--text-primary)]">
      {isColor && (
        <span style={{ display: "inline-block", width: "0.7em", height: "0.7em", borderRadius: "50%", background: text, border: "1px solid color-mix(in srgb, var(--text-primary) 20%, transparent)", marginRight: "0.35em", verticalAlign: "middle" }} />
      )}
      {children}
    </code>
  );
}

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
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath, remarkPromoteDisplayMath, remarkCallout]}
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
