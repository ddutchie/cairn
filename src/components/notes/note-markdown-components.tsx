"use client";

import React, { useMemo } from "react";
import type { ExtraProps, Components } from "react-markdown";
import { cn } from "@/lib/utils";
import { renderCodeFence } from "./markdown-code-fence";
import { headingSlug } from "./TableOfContents";
import { Callout } from "./Callout";
import { MathBlock } from "./MathBlock";
import { InlineCode } from "@/lib/markdown/pipeline";
import type { Note } from "@/types";

/**
 * Render a table cell's children, converting any leading `[ ]` / `[x]` token
 * into a clickable checkbox. GFM table cells only parse inline content, so
 * remark-gfm never emits checkbox nodes inside `<td>`/`<th>` — we recover them
 * here so table task-lists are interactive like list task-items.
 *
 * Only the first text child is inspected (the token must lead the cell, mirroring
 * GFM task-list semantics: `| [x] done | …`). Toggle wiring maps the rendered
 * checkbox back to source order via toggleCheckboxInSource().
 */
export function renderCellWithCheckboxes(
  children: React.ReactNode,
  onToggle: (el: HTMLInputElement) => void
): React.ReactNode {
  const arr = React.Children.toArray(children);
  if (arr.length === 0) return children;

  const first = arr[0];
  if (typeof first !== "string") return children;

  const m = first.match(/^\s*\[([ xX])\]\s?/);
  if (!m) return children;

  const checked = m[1] !== " ";
  const rest = first.slice(m[0].length);
  return (
    <>
      <input
        type="checkbox"
        defaultChecked={checked}
        className="cursor-pointer accent-[var(--accent)] w-3.5 h-3.5 relative top-[1px] mr-1"
        onChange={(e) => onToggle(e.currentTarget)}
      />
      {rest}
      {arr.slice(1)}
    </>
  );
}

/**
 * The ReactMarkdown `components` override map for the note read-mode preview,
 * extracted from note-editor.tsx. Returns a referentially-stable map (memoized
 * on `toggleCheckbox`) so ReactMarkdown doesn't rebuild its processor on
 * unrelated store updates.
 *
 * `notesRef` and `previewScrollRef` are stable React refs — read via `.current`
 * inside the resolvers so the map doesn't depend on the `notes` array (which
 * would rebuild the whole component map, and thus re-parse the preview + remount
 * KaTeX, on every note edit / sync tick). `toggleCheckbox` carries the note
 * id/content/updateNote closure for checkbox source-toggling.
 */
export function useNoteMarkdownComponents({
  toggleCheckbox,
  notesRef,
  previewScrollRef,
}: {
  toggleCheckbox: (el: HTMLInputElement) => void;
  notesRef: React.RefObject<Note[]>;
  previewScrollRef: React.RefObject<HTMLDivElement | null>;
}): Components {
  return useMemo(() => ({
    // Images — renders asset:// and https:// URLs
    img({ src, alt }: { src?: string; alt?: string }) {
      const srcStr = typeof src === "string" && src !== "" ? src : undefined;
      const isExternal = srcStr?.startsWith("http://") || srcStr?.startsWith("https://");
      const imgEl = (
        <img
          src={srcStr}
          alt={alt ?? ""}
          referrerPolicy="no-referrer"
          className="max-w-full rounded-md my-2 border border-[var(--border)]"
        />
      );
      if (isExternal && srcStr) {
        const url = srcStr;
        return (
          <a
            href={url}
            onClick={(e) => {
              e.preventDefault();
              const el = (window as { electron?: { openExternal?: (u: string) => void } }).electron;
              if (el?.openExternal) el.openExternal(url);
              else window.open(url, "_blank");
            }}
            className="block"
          >
            {imgEl}
          </a>
        );
      }
      return imgEl;
    },
    mark({ children }: { children?: React.ReactNode }) {
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
      const latex: string = (props as Record<string, string>)["data-latex"] ?? "";
      return <MathBlock key={latex} latex={latex} renderedChildren={children} />;
    },
    blockquote({ children }: { children?: React.ReactNode }) {
      return (
        <blockquote className="border-l-2 border-[var(--border)] pl-4 text-[var(--text-secondary)] my-3">
          {children}
        </blockquote>
      );
    },
    // Clickable checkboxes — toggle [ ] ↔ [x] in the raw markdown source
    input({ type, checked }: { type?: string; checked?: boolean }) {
      if (type !== "checkbox") return <input type={type} />;
      return (
        <input
          type="checkbox"
          defaultChecked={checked}
          className="cursor-pointer accent-[var(--accent)] w-3.5 h-3.5 relative top-[1px]"
          onChange={(e) => toggleCheckbox(e.currentTarget)}
        />
      );
    },
    pre({ children }: { children?: React.ReactNode }) {
      return renderCodeFence(children);
    },
    code({ className, children }: { className?: string; children?: React.ReactNode }) {
      return <InlineCode className={className}>{children}</InlineCode>;
    },
    h1({ children }: { children?: React.ReactNode }) {
      const text = String(children); const id = headingSlug(text);
      return <h1 id={id} data-heading-id={id}>{children}</h1>;
    },
    h2({ children }: { children?: React.ReactNode }) {
      const text = String(children); const id = headingSlug(text);
      return <h2 id={id} data-heading-id={id}>{children}</h2>;
    },
    h3({ children }: { children?: React.ReactNode }) {
      const text = String(children); const id = headingSlug(text);
      return <h3 id={id} data-heading-id={id}>{children}</h3>;
    },
    sup({ children, ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
      const isFootnoteRef = (props as Record<string, unknown>)["data-footnote-ref"] === true;
      if (!isFootnoteRef) return <sup>{children}</sup>;
      return (
        <sup className="text-[0.714rem] leading-none" style={{ color: "var(--accent)", fontFeatureSettings: "'sups' 0" }}>
          {children}
        </sup>
      );
    },
    a({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
      if (href?.startsWith("#")) {
        const isFootnoteRef = (props as Record<string, unknown>)["data-footnote-ref"] === true;
        const rawClassName: unknown = props.className;
        const isBackref = typeof rawClassName === "string"
          ? rawClassName.includes("data-footnote-backref")
          : Array.isArray(rawClassName) && rawClassName.includes("data-footnote-backref");
        return (
          <a
            {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
            href={href}
            style={isFootnoteRef ? { color: "var(--accent)", textDecoration: "none" } : undefined}
            aria-label={isBackref ? "Back to reference" : undefined}
            onClick={(e) => {
              e.preventDefault();
              const rawId = href.slice(1);
              const container = previewScrollRef.current;
              if (!container) return;
              const target =
                container.querySelector(`[data-heading-id="${rawId}"]`) ??
                container.querySelector(`[id="${CSS.escape(rawId)}"]`);
              target?.scrollIntoView({ behavior: "smooth", block: isBackref ? "center" : "start" });
            }}
          >
            {children}
          </a>
        );
      }
      if (href) {
        const isExternal = /^(https?:|\/\/)/.test(href);
        if (isExternal) {
          return (
            <a
              {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                e.preventDefault();
                const el = (window as { electron?: { openExternal?: (u: string) => void } }).electron;
                if (el?.openExternal) el.openExternal(href);
                else window.open(href, "_blank");
              }}
            >
              {children}
            </a>
          );
        }
        const stripped = href.replace(/^\.?\//, "").replace(/\.md$/i, "").replace(/^[./]+/, "");
        const target = notesRef.current.find(
          (n) =>
            n.title.toLowerCase() === stripped.toLowerCase() ||
            n.title.toLowerCase() === stripped.replace(/[-_]/g, " ").toLowerCase() ||
            n.id === stripped,
        );
        return (
          <a
            {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
            href={href}
            title={target ? `Open: ${target.title}` : href}
            style={target ? { color: "var(--accent)", textDecoration: "none" } : undefined}
            onClick={(e) => {
              e.preventDefault();
              if (target) {
                window.dispatchEvent(new CustomEvent("cairn:select-note", { detail: { noteId: target.id } }));
              }
            }}
          >
            {children}
          </a>
        );
      }
      return <a href={href} {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>;
    },
    section({ children, ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
      if ((props.className ?? "").includes("footnotes")) {
        return (
          <section {...props} className="footnotes mt-8 pt-4 text-[0.786rem] text-[var(--text-secondary)]" style={{ borderTop: "1px solid var(--border)" }}>
            {children}
          </section>
        );
      }
      return <section {...props}>{children}</section>;
    },
    wikilink({ ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
      const title = (props as Record<string, string>)["data-title"] ?? "";
      const target = notesRef.current.find((n) => n.title.toLowerCase() === title.toLowerCase());
      const resolved = target != null;
      return (
        <button
          type="button"
          onClick={() => {
            if (target) {
              window.dispatchEvent(new CustomEvent("cairn:select-note", { detail: { noteId: target.id } }));
            }
          }}
          title={resolved ? `Open: ${title}` : `Note not found: ${title}`}
          className={cn(
            "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[0.82em] font-medium transition-colors align-baseline",
            resolved
              ? "text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] cursor-pointer"
              : "text-[var(--text-tertiary)] bg-[var(--surface-2)] cursor-default opacity-60"
          )}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
          {resolved ? title : `${title} ↗`}
        </button>
      );
    },
    table({ children }: { children?: React.ReactNode }) {
      return (
        <div className="w-full overflow-x-auto my-3 scrollbar-thin">
          <table className="min-w-full border-collapse">
            {children}
          </table>
        </div>
      );
    },
    td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
      return <td style={style}>{renderCellWithCheckboxes(children, toggleCheckbox)}</td>;
    },
    th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
      return <th style={style}>{renderCellWithCheckboxes(children, toggleCheckbox)}</th>;
    },
  // previewScrollRef is a stable React ref — no need to list it as a dep.
  // notes is read via notesRef (not a dep) so this component map stays
  // referentially stable across unrelated store updates; toggleCheckbox carries
  // the note id/content/updateNote closure for checkbox source-toggling.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [toggleCheckbox]) as Components;
}
