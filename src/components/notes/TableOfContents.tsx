"use client";

/**
 * TableOfContents — floating TOC panel for the note read view.
 *
 * Parses headings directly from the markdown source (no DOM walking needed)
 * so it works before the renderer has painted. Renders a sticky panel to the
 * right of the 680px content column that is hidden on narrow viewports.
 *
 * Also exports `headingSlug` so the ReactMarkdown heading components can
 * produce matching `id` attributes.
 */

import { useMemo, useEffect, useState, useRef } from "react";
import { cn } from "@/lib/utils";
import { parseWikilinks } from "@/lib/wikilink-parser";

// ── Slug ─────────────────────────────────────────────────────────────────────

/**
 * GitHub-style heading slug: lowercase, spaces → hyphens, strip everything
 * except alphanumerics and hyphens.
 */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Heading extraction ────────────────────────────────────────────────────────

export interface Heading {
  level: 1 | 2 | 3;
  text: string;
  id: string;
}

/** Parse h1/h2/h3 headings from raw markdown source. */
export function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  // Match ATX-style headings (# / ## / ###) — ignore headings inside code fences
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^(#{1,3})\s+(.+)/);
    if (m) {
      const level = m[1].length as 1 | 2 | 3;
      const text = m[2].trim();
      headings.push({ level, text, id: headingSlug(text) });
    }
  }
  return headings;
}

// ── Wikilink extraction ───────────────────────────────────────────────────────

export interface WikiLink {
  title: string;
  noteId: string | null;
}

/** Extract unique wikilinks from raw markdown, deduplicated by title. */
export function extractWikiLinks(
  markdown: string,
  notes: { id: string; title: string }[]
): WikiLink[] {
  const titleIndex = new Map(notes.map((n) => [n.title.toLowerCase().trim(), n.id]));
  const seen = new Set<string>();
  const links: WikiLink[] = [];
  for (const { title } of parseWikilinks(markdown)) {
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ title, noteId: titleIndex.get(key) ?? null });
  }
  return links;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  markdown: string;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Pass workspace notes to render a Links section in the TOC */
  notes?: { id: string; title: string }[];
}

// Minimum gap (px) to maintain between the content column right edge and the TOC left edge
const MIN_GAP = 24;

export function TableOfContents({ markdown, scrollContainerRef, notes = [] }: Props) {
  const headings  = useMemo(() => extractHeadings(markdown), [markdown]);
  const wikiLinks = useMemo(() => extractWikiLinks(markdown, notes), [markdown, notes]);
  const [visible, setVisible] = useState(false);
  const tocRef = useRef<HTMLDivElement>(null);

  // Measure actual DOM positions rather than guessing a fixed pixel threshold.
  // Hides whenever the TOC left edge would be within MIN_GAP of the content column right edge.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    function check() {
      const toc = tocRef.current;
      if (!toc) return;
      // Content column: the first child div inside the scroll container
      // (the px-6 py-5 max-w-4xl mx-auto wrapper)
      const contentCol = container!.querySelector<HTMLElement>(":scope > div:not([class*='absolute'])");
      if (!contentCol) return;
      const contentRight = contentCol.getBoundingClientRect().right;
      const tocLeft = toc.getBoundingClientRect().left;
      setVisible(tocLeft - contentRight >= MIN_GAP);
    }

    const ro = new ResizeObserver(check);
    ro.observe(container);
    // Also re-check when the window resizes (sidebar open/close changes container width)
    window.addEventListener("resize", check);
    // Initial check after paint so TOC ref is available
    requestAnimationFrame(check);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", check);
    };
  }, [scrollContainerRef]);

  if (headings.length < 2 && wikiLinks.length === 0) return null;

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>, id: string) {
    e.preventDefault();
    const container = scrollContainerRef.current;
    if (!container) return;
    const target = container.querySelector(`[data-heading-id="${id}"]`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  return (
    // Always rendered so tocRef is in the DOM for measurement.
    // Visibility controlled by the `visible` state — using opacity+pointer-events
    // rather than conditional render so the ResizeObserver can measure positions.
    <div
      ref={tocRef}
      className="absolute top-5 right-4 w-52 flex-shrink-0 transition-opacity duration-150"
      style={{ opacity: visible ? 1 : 0, pointerEvents: visible ? "auto" : "none" }}
    >
      <div className="sticky top-5 space-y-4">
        {headings.length >= 2 && (
          <div>
            <p className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] mb-2 px-1">
              On this page
            </p>
            <nav className="flex flex-col gap-0.5">
              {headings.map((h, i) => (
                <a
                  key={`${h.id}-${i}`}
                  href={`#${h.id}`}
                  onClick={(e) => handleClick(e, h.id)}
                  className={cn(
                    "text-[0.786rem] leading-snug truncate rounded px-1 py-0.5 transition-colors",
                    "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]",
                    h.level === 1 && "font-medium",
                    h.level === 2 && "pl-3",
                    h.level === 3 && "pl-5 text-[0.714rem]",
                  )}
                  title={h.text}
                >
                  {h.text}
                </a>
              ))}
            </nav>
          </div>
        )}

        {wikiLinks.length > 0 && (
          <div>
            <p className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] mb-2 px-1">
              Links
            </p>
            <nav className="flex flex-col gap-0.5">
              {wikiLinks.map((wl, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    if (wl.noteId) {
                      window.dispatchEvent(new CustomEvent("cairn:select-note", { detail: { noteId: wl.noteId } }));
                    }
                  }}
                  title={wl.noteId ? `Open: ${wl.title}` : `Note not found: ${wl.title}`}
                  className={cn(
                    "flex items-center gap-1.5 w-full text-left text-[0.786rem] leading-snug truncate rounded px-1 py-0.5 transition-colors",
                    wl.noteId
                      ? "text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] cursor-pointer"
                      : "text-[var(--text-tertiary)] opacity-50 cursor-default"
                  )}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                  </svg>
                  <span className="truncate">{wl.title}</span>
                </button>
              ))}
            </nav>
          </div>
        )}
      </div>
    </div>
  );
}
