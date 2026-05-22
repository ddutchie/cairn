"use client";

import React from "react";
import type { Plugin as RemarkPlugin } from "unified";
import type { Root as MdastRoot, Blockquote, Paragraph, Text as MdastText } from "mdast";
import type { InlineMath } from "mdast-util-math";
import { visit as mdastVisit } from "unist-util-visit";
import type { Plugin } from "unified";
import type { Root, Element, Text, ElementContent, Parent } from "hast";
import { visit, SKIP } from "unist-util-visit";
import { WIKILINK_RE } from "@/lib/wikilink-parser";

// ── Remark plugin: callout blockquotes ────────────────────────────────────────
const CALLOUT_RE = /^\[!([^\]]+)\]([\+\-]?)([\s\S]*)/;

export const remarkCallout: RemarkPlugin<[], MdastRoot> = () => (tree) => {
  mdastVisit(tree, "blockquote", (node: Blockquote) => {
    const firstPara = node.children[0];
    if (!firstPara || firstPara.type !== "paragraph") return;

    const firstChild = (firstPara as Paragraph).children[0];
    if (!firstChild || firstChild.type !== "text") return;

    const firstValue = (firstChild as MdastText).value;
    const match = firstValue.match(CALLOUT_RE);
    if (!match) return;

    const [, rawType, modifier, restOfFirstLine] = match;
    const calloutType = rawType.trim().toLowerCase();
    const collapsible = modifier === "+" || modifier === "-";
    const defaultOpen = modifier !== "-";
    const title = restOfFirstLine.trim();

    // Strip the "[!type]\n" prefix from the first text node so the body renders cleanly.
    const afterDirective = firstValue.slice(firstValue.indexOf("\n") + 1);
    (firstChild as MdastText).value = afterDirective;

    // Tag the blockquote node with hast properties so remark-rehype renders it
    // as <callout data-type="note" data-title="..." ...> which ReactMarkdown
    // maps to the callout() component via the components prop.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node as any).data = {
      hName: "callout",
      hProperties: {
        "data-callout-type": calloutType,
        "data-title": title,
        "data-collapsible": collapsible ? "true" : "false",
        "data-default-open": defaultOpen ? "true" : "false",
      },
    };
  });
};

// ── Remark plugin: wikilinks [[Title]] → <wikilink data-title="Title"> ────────
export const remarkWikilinks: RemarkPlugin<[], MdastRoot> = () => (tree) => {
  const re = new RegExp(WIKILINK_RE.source, "g");
  mdastVisit(tree, "text", (node: MdastText, index, parent) => {
    if (index == null || !parent) return;
    const text = node.value;
    const newNodes: MdastRoot["children"][number][] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const title = m[1].trim();
      if (lastIndex < m.index) {
        newNodes.push({ type: "text", value: text.slice(lastIndex, m.index) });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      newNodes.push({ type: "text", value: "", data: { hName: "wikilink", hProperties: { "data-title": title } } } as any);
      lastIndex = m.index + m[0].length;
    }
    if (newNodes.length === 0) return;
    if (lastIndex < text.length) {
      newNodes.push({ type: "text", value: text.slice(lastIndex) });
    }
    // Replace the current node with the split nodes
    parent.children.splice(index, 1, ...(newNodes as MdastRoot["children"]));
    // Return the index delta so visitor skips re-visiting replaced nodes
    return index + newNodes.length;
  });
};

// ── Remark plugin: promote standalone inlineMath to display math ──────────────
export const remarkPromoteDisplayMath: RemarkPlugin<[], MdastRoot> = () => (tree) => {
  mdastVisit(tree, "paragraph", (node: Paragraph) => {
    if (
      node.children.length === 1 &&
      node.children[0].type === "inlineMath"
    ) {
      const inlineMath = node.children[0] as InlineMath;
      inlineMath.data = {
        ...inlineMath.data,
        hName: "code",
        hProperties: { className: ["language-math", "math-display"] },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node as any).data = { hName: "pre", hProperties: {} };
    }
  });
};

// ── Rehype plugins: math tagging + ==highlight== marks ───────────────────────
export function makeLatexPlugins() {
  const latexBlocks: string[] = [];

  const rehypeCaptureLatex: Plugin<[], Root> = () => (tree) => {
    latexBlocks.length = 0;
    visit(tree, "element", (node: Element) => {
      const cls = (node.properties?.className as string[] | undefined) ?? [];
      if (cls.includes("math-display")) {
        const text = (node.children[0] as Text | undefined)?.value ?? "";
        latexBlocks.push(text);
      }
    });
  };

  const rehypeMergedPass: Plugin<[], Root> = () => (tree) => {
    let i = 0;
    visit(tree, (node, index, parent) => {
      // ── Job 1: rename katex-display spans to <mathblock> ──────────────────
      if (node.type === "element") {
        const cls = ((node as Element).properties?.className as string[] | undefined) ?? [];
        if (cls.includes("katex-display")) {
          if (latexBlocks[i] !== undefined) {
            (node as Element).tagName = "mathblock";
            (node as Element).properties = { "data-latex": latexBlocks[i++] };
          }
          // Skip the entire KaTeX subtree — it contains no ==marks== and
          // we've already handled this katex-display node.
          return SKIP;
        }
      }

      // ── Job 2: ==highlight== marks → <mark> elements ──────────────────────
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
                const mark: Element = {
                  type: "element",
                  tagName: "mark",
                  properties: {},
                  children: [{ type: "text", value: part.slice(2, -2) }],
                };
                return mark;
              }
              if (part === "") return null;
              return { type: "text", value: part } as Text;
            })
            .filter((n): n is ElementContent => n !== null);
          (parent as Parent).children.splice(index, 1, ...nodes);
          return index; // revisit from same position after splice
        }
      }
    });
  };

  return { rehypeCaptureLatex, rehypeMergedPass };
}

// ── Color swatch inline code renderer ────────────────────────────────────────
const COLOR_RE = /^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(rgba?|hsla?)\s*\([^)]+\))$/i;

export function InlineCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  if (className?.startsWith("language-")) return <>{children}</>;
  const text = String(children ?? "").trim();
  const isColor = COLOR_RE.test(text);
  return (
    <code className="px-1 py-0.5 rounded bg-[var(--surface-3)] font-mono text-[0.786rem] text-[var(--text-primary)]">
      {isColor && (
        <span
          style={{
            display: "inline-block",
            width: "0.7em",
            height: "0.7em",
            borderRadius: "50%",
            background: text,
            border: "1px solid color-mix(in srgb, var(--text-primary) 20%, transparent)",
            marginRight: "0.35em",
            verticalAlign: "middle",
            flexShrink: 0,
          }}
        />
      )}
      {children}
    </code>
  );
}
