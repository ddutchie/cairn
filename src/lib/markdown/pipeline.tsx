"use client";

import React from "react";
import type { Plugin as RemarkPlugin } from "unified";
import type { Root as MdastRoot, Blockquote, Paragraph, Text as MdastText } from "mdast";
import type { InlineMath } from "mdast-util-math";
import { visit as mdastVisit } from "unist-util-visit";
import type { Plugin, PluggableList } from "unified";
import type { Root, Element, Text, ElementContent, Parent } from "hast";
import { visit, SKIP } from "unist-util-visit";
import { WIKILINK_RE } from "@/lib/wikilink-parser";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";

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

    // `restOfFirstLine` is `[\s\S]*` — i.e. everything after `[!type]modifier`,
    // which may span multiple lines (e.g. `[!note]\nbody`). The title is only
    // the first line after the directive; anything after the first `\n` is body
    // content. When there's no `\n` (e.g. `> [!important]` alone, or
    // `> [!important] Title` with body on subsequent blockquote lines), the
    // entire `restOfFirstLine` is the title and there is no inline body — so
    // the first text node must be emptied to prevent the directive `[!type]`
    // from leaking into the rendered body.
    const newlineIdx = restOfFirstLine.indexOf("\n");
    const title = (newlineIdx === -1 ? restOfFirstLine : restOfFirstLine.slice(0, newlineIdx)).trim();
    const afterDirective = newlineIdx === -1 ? "" : restOfFirstLine.slice(newlineIdx + 1);
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

// ── Remark plugin: Obsidian embeds ![[file.png]] → <img> ──────────────────────
// Converts ![[filename.ext]] and ![[filename.ext|width]] into standard markdown
// image nodes. Supports common image extensions. Must run BEFORE remarkWikilinks
// so the `!` prefix embeds are consumed first.
const EMBED_RE = /!\[\[([^\][\n]+?)\]\]/g;
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);

export const remarkObsidianEmbeds: RemarkPlugin<[], MdastRoot> = () => (tree) => {
  mdastVisit(tree, "text", (node: MdastText, index, parent) => {
    if (index == null || !parent) return;
    const text = node.value;
    const newNodes: MdastRoot["children"][number][] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    const re = new RegExp(EMBED_RE.source, "g");
    while ((m = re.exec(text)) !== null) {
      const inner = m[1].trim();
      // Split on `|` for optional width: ![[file.png|300]]
      const [filePart, widthStr] = inner.split("|").map((s) => s.trim());
      const ext = filePart.split(".").pop()?.toLowerCase() ?? "";

      if (!IMAGE_EXTS.has(ext)) continue; // not an image — skip

      if (lastIndex < m.index) {
        newNodes.push({ type: "text", value: text.slice(lastIndex, m.index) });
      }

      // Create a standard image node — the asset:// protocol resolves the file
      const width = widthStr ? parseInt(widthStr, 10) : undefined;
      const imageNode = {
        type: "image" as const,
        url: `asset://${filePart}`,
        alt: filePart,
        title: null,
        data: width
          ? { hProperties: { width: `${width}px`, style: `max-width: ${width}px` } }
          : undefined,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      newNodes.push(imageNode as any);
      lastIndex = m.index + m[0].length;
    }
    if (newNodes.length === 0) return;
    if (lastIndex < text.length) {
      newNodes.push({ type: "text", value: text.slice(lastIndex) });
    }
    parent.children.splice(index, 1, ...(newNodes as MdastRoot["children"]));
    return index + newNodes.length;
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

// ── Rehype plugin: escape unknown "HTML" tags back to literal text ────────────
// rehypeRaw parses any <angle-bracket> sequence as raw HTML. Non-HTML text like
// "<repo>", "<TOKEN>", or a generic "Array<T>" then becomes an unknown element
// which React refuses to render ("The tag <repo> is unrecognized"). This runs
// after rehypeRaw and converts elements whose tagName is NOT a real HTML element
// (nor a custom tag our pipeline introduces) back into literal text nodes, so
// they render as the author typed them instead of crashing the preview.
const KNOWN_HTML_TAGS = new Set([
  // Sectioning / text content
  "a","abbr","address","area","article","aside","audio","b","base","bdi","bdo","blockquote","body","br","button",
  "canvas","caption","cite","code","col","colgroup","data","datalist","dd","del","details","dfn","dialog","div","dl","dt",
  "em","embed","fieldset","figcaption","figure","footer","form","h1","h2","h3","h4","h5","h6","head","header","hgroup","hr",
  "html","i","iframe","img","input","ins","kbd","label","legend","li","link","main","map","meta","meter","nav","noscript",
  "object","ol","optgroup","option","output","p","param","picture","pre","progress","q","rp","rt","ruby","s","samp","script",
  "section","select","slot","small","source","span","strong","style","sub","summary","sup","table","tbody","td","template",
  "textarea","tfoot","th","thead","time","title","tr","track","u","ul","var","video","wbr",
  // SVG (KaTeX / diagrams emit these)
  "svg","path","g","rect","circle","line","polyline","polygon","text","tspan","defs","use","symbol","marker","mask","pattern",
  "clippath","lineargradient","radialgradient","stop","foreignobject",
  // MathML (KaTeX)
  "math","semantics","mrow","mi","mo","mn","msup","msub","mfrac","msqrt","annotation",
  // Custom tags this pipeline maps to React components
  "mark","callout","mathblock","wikilink",
]);

export const rehypeEscapeUnknownTags: Plugin<[], Root> = () => (tree) => {
  visit(tree, "element", (node, index, parent) => {
    const tag = (node as Element).tagName?.toLowerCase();
    if (!tag || KNOWN_HTML_TAGS.has(tag) || !parent || index === undefined) return;
    // Rebuild the literal source faithfully — including attributes and nested
    // markup — so escaping an unknown tag doesn't silently drop the author's
    // content (previously only direct text children survived).
    const literal = serializeHast(node as Element);
    (parent.children as ElementContent[])[index] = { type: "text", value: literal };
  });
};

// ── Rehype plugin: "what's new" changed-line highlight (read/preview mode) ────
// Adds the `cm-changed-line` class to block-level rendered elements whose source
// lines overlap `changedLines` (1-indexed source line numbers). This mirrors the
// CodeMirror decoration in the Write-mode editor so the read-mode preview shows
// the same fading highlight. Uses each hast node's `position` (source mapping)
// which remark-rehype preserves. Highlighting is applied to top-level blocks and
// list items; a hit on any covered line lights up the whole block.
export function makeRehypeChangedLines(changedLines: number[]): Plugin<[], Root> {
  const changed = new Set(changedLines);
  // Block-level tags we highlight. Deliberately excludes inline tags so we tint
  // whole blocks rather than fragments.
  const BLOCK_TAGS = new Set([
    "p", "li", "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "pre", "table", "tr", "hr", "img",
  ]);
  return () => (tree) => {
    if (changed.size === 0) return;
    visit(tree, "element", (node: Element) => {
      const tag = node.tagName?.toLowerCase();
      if (!tag || !BLOCK_TAGS.has(tag)) return;
      const pos = node.position;
      if (!pos?.start?.line || !pos?.end?.line) return;
      // Any source line in [start, end] that's in the changed set marks the block.
      let hit = false;
      for (let ln = pos.start.line; ln <= pos.end.line; ln++) {
        if (changed.has(ln)) { hit = true; break; }
      }
      if (!hit) return;
      const props = (node.properties ??= {});
      const cls = props.className;
      const existing = Array.isArray(cls) ? cls.map(String) : cls ? [String(cls)] : [];
      if (!existing.includes("cm-changed-line")) existing.push("cm-changed-line");
      props.className = existing;
    });
  };
}

/** Minimal HAST → HTML-source serializer (attributes + recursive children). */
function serializeHast(node: ElementContent): string {
  if (node.type === "text") return (node as Text).value;
  if (node.type !== "element") return "";
  const el = node as Element;
  const attrs = Object.entries(el.properties ?? {})
    .map(([k, v]) => {
      const name = hastPropName(k);
      if (v === true) return ` ${name}`;
      if (v === false || v == null) return "";
      const value = Array.isArray(v) ? v.join(" ") : String(v);
      return ` ${name}="${value.replace(/"/g, "&quot;")}"`;
    })
    .join("");
  const inner = (el.children ?? []).map((c) => serializeHast(c as ElementContent)).join("");
  return inner ? `<${el.tagName}${attrs}>${inner}</${el.tagName}>` : `<${el.tagName}${attrs}>`;
}

/** Map a few HAST property names back to their HTML attribute spelling. */
function hastPropName(k: string): string {
  if (k === "className") return "class";
  if (k === "htmlFor") return "for";
  return k;
}

// ── Rehype plugins: math tagging + ==highlight== marks ───────────────────────

/**
 * Cheap source-level probes so the LaTeX/highlight passes can skip their
 * full-tree traversals when the document can't possibly contain the relevant
 * syntax. KaTeX rendering + the two custom hast passes are ~12ms on a large
 * note; the vast majority of notes have no math, so gating on a single
 * substring check avoids that cost entirely.
 */
export function contentHasMath(content: string): boolean {
  return content.includes("$");
}
export function contentHasHighlight(content: string): boolean {
  return content.includes("==");
}

/**
 * Build the LaTeX capture + merge passes. When `content` is provided, the passes
 * short-circuit based on cheap source probes:
 *  - `rehypeCaptureLatex` does nothing when there's no `$` in the source.
 *  - `rehypeMergedPass` skips its traversal entirely when there's neither math
 *    (`$`, which produces katex-display spans to rename) nor `==` highlights.
 * Omitting `content` preserves the original always-run behaviour (used by the
 * benchmark harness, which measures worst-case cost).
 */
export function makeLatexPlugins(content?: string) {
  const latexBlocks: string[] = [];
  const mayHaveMath = content === undefined || contentHasMath(content);
  const mayHaveHighlight = content === undefined || contentHasHighlight(content);

  const rehypeCaptureLatex: Plugin<[], Root> = () => (tree) => {
    latexBlocks.length = 0;
    if (!mayHaveMath) return; // no `$` in source → no math-display nodes to capture
    visit(tree, "element", (node: Element) => {
      const cls = (node.properties?.className as string[] | undefined) ?? [];
      if (cls.includes("math-display")) {
        const text = (node.children[0] as Text | undefined)?.value ?? "";
        latexBlocks.push(text);
      }
    });
  };

  const rehypeMergedPass: Plugin<[], Root> = () => (tree) => {
    // Nothing to do if the source has neither math (katex-display spans to
    // rename) nor `==highlight==` marks to split.
    if (!mayHaveMath && !mayHaveHighlight) return;
    let i = 0;
    visit(tree, (node, index, parent) => {
      // ── Job 1: rename katex-display spans to <mathblock> ──────────────────
      if (mayHaveMath && node.type === "element") {
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
        mayHaveHighlight &&
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

// ── Content-aware plugin-array builders ───────────────────────────────────────
//
// react-markdown rebuilds and re-runs its unified processor whenever the
// remark/rehype plugin arrays change *by reference*. The note renderers used to
// hardcode inline arrays that (a) allocated a new array every render and (b)
// always included the full math stack (remark-math + rehype-katex + the two
// custom LaTeX passes ≈ 12ms on a large note) even for the common math-free
// note. These builders return arrays that omit the math plugins when the source
// has no `$`, so callers can `useMemo` them keyed on content and skip that cost.
//
// The builders take the already-memoized custom-LaTeX pair (from
// `makeLatexPlugins(content)`) plus any note-specific extras (wikilinks,
// changed-line highlight) so a single helper serves both note renderers.

interface RemarkBuildOpts {
  /** Include remarkWikilinks (`[[Note]]` → <wikilink>). Note editor: true. */
  wikilinks?: boolean;
}

/** Assemble the remark plugin list for a note renderer, omitting remark-math
 *  when the source has no `$`. */
export function buildNoteRemarkPlugins(content: string, opts: RemarkBuildOpts = {}): PluggableList {
  const plugins: PluggableList = [remarkGfm, remarkBreaks];
  if (contentHasMath(content)) {
    // remarkMath must precede remarkPromoteDisplayMath (which reshapes math nodes).
    plugins.push(remarkMath, remarkPromoteDisplayMath);
  }
  plugins.push(remarkCallout, remarkObsidianEmbeds);
  if (opts.wikilinks) plugins.push(remarkWikilinks);
  return plugins;
}

interface RehypeBuildOpts {
  /** The memoized LaTeX pair from makeLatexPlugins(content). */
  latex: ReturnType<typeof makeLatexPlugins>;
  /** Optional read-mode changed-line highlight plugin (note editor only). */
  changedLines?: Plugin<[], Root>;
}

/** Assemble the rehype plugin list for a note renderer, omitting rehype-katex
 *  and the LaTeX capture pass when the source has no `$`. The merge pass is
 *  always included (it also handles `==highlight==`) but self-skips cheaply. */
export function buildNoteRehypePlugins(content: string, opts: RehypeBuildOpts): PluggableList {
  const { latex, changedLines } = opts;
  const plugins: PluggableList = [rehypeRaw];
  if (changedLines) plugins.push(changedLines);
  plugins.push(rehypeEscapeUnknownTags);
  if (contentHasMath(content)) {
    plugins.push(latex.rehypeCaptureLatex, rehypeKatex);
  }
  // The merged pass renames katex-display spans (only present when math ran) and
  // splits ==highlight== marks; it self-skips when neither is possible.
  plugins.push(latex.rehypeMergedPass);
  return plugins;
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
