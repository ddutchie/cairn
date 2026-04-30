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

import { useMemo } from "react";
import { cn } from "@/lib/utils";

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

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  markdown: string;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

export function TableOfContents({ markdown, scrollContainerRef }: Props) {
  const headings = useMemo(() => extractHeadings(markdown), [markdown]);

  if (headings.length < 2) return null;

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
    // Hidden below xl (when there's not enough room beside the 680px column)
    <div className="hidden xl:block absolute top-5 right-4 w-52 flex-shrink-0">
      <div className="sticky top-5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] mb-2 px-1">
          On this page
        </p>
        <nav className="flex flex-col gap-0.5">
          {headings.map((h, i) => (
            <a
              key={`${h.id}-${i}`}
              href={`#${h.id}`}
              onClick={(e) => handleClick(e, h.id)}
              className={cn(
                "text-[11px] leading-snug truncate rounded px-1 py-0.5 transition-colors",
                "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]",
                h.level === 1 && "font-medium",
                h.level === 2 && "pl-3",
                h.level === 3 && "pl-5 text-[10px]",
              )}
              title={h.text}
            >
              {h.text}
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}
