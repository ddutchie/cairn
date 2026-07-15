/**
 * Pure helpers to convert Cairn-specific markdown syntax into HTML fragments
 * that match the desktop PDF template's CSS (`shared/notes/pdf-template.ts`):
 *
 *   - Callout blocks  `> [!type] Title\n> body`  ->  <div data-callout
 *       data-callout-type="type"><div>…title…</div><div>…body…</div></div>
 *   - Wikilinks       `[[Title]]`                ->  <span class="wikilink-chip">Title</span>
 *
 * These are string transforms with NO markdown-it / native dependency, so they
 * live in shared and are unit-testable. The caller (mobile note→HTML renderer)
 * runs these, then feeds the result through markdown-it with html:true so the
 * emitted HTML passes through untouched while the rest of the markdown renders.
 *
 * The body of a callout is returned as raw text with `<br>` for line breaks —
 * intentionally NOT re-run through the markdown renderer, to keep the block
 * self-contained and avoid markdown-it re-escaping the wrapper div.
 */

import { WIKILINK_RE, parseCalloutHeader } from "./markdown";

/** Escape a string for safe inclusion in HTML text/attribute context. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

/**
 * Replace `[[Title]]` wikilinks with styled chips. Operates on a single line /
 * inline string. Titles are HTML-escaped. (In a PDF the chip is non-interactive,
 * matching the desktop template which hides the chip's icon svg.)
 */
export function wikilinksToChips(text: string): string {
  return text.replace(WIKILINK_RE, (_all, title: string) =>
    `<span class="wikilink-chip">${escapeHtml(title.trim())}</span>`);
}

/**
 * Extract Obsidian-style callout blocks and convert them to the desktop
 * `[data-callout]` HTML structure. Non-callout lines are returned unchanged so
 * the result can be handed to a markdown renderer for the rest of the document.
 *
 * A callout is a blockquote whose first line is `[!type] Optional Title`:
 *
 *     > [!warning] Heads up
 *     > body line 1
 *     > body line 2
 */
export function calloutsToHtml(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // A callout starts with a blockquote line whose content is `[!type] …`.
    const bqMatch = /^\s*>\s?(.*)$/.exec(line);
    const meta = bqMatch ? parseCalloutHeader(bqMatch[1]) : null;
    if (bqMatch && meta) {
      // Consume subsequent blockquote lines as the callout body.
      const bodyLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const cont = /^\s*>\s?(.*)$/.exec(lines[i]);
        if (!cont) break;
        bodyLines.push(cont[1]);
        i += 1;
      }
      const type = escapeHtml(meta.type);
      const title = escapeHtml(meta.title || meta.type.charAt(0).toUpperCase() + meta.type.slice(1));
      const body = bodyLines
        .map((l) => wikilinksToChips(escapeHtml(l)))
        .join("<br>");
      out.push(
        `<div data-callout data-callout-type="${type}">` +
        `<div><span></span>${title}</div>` +
        `<div>${body}</div>` +
        `</div>`,
      );
      continue;
    }
    out.push(line);
    i += 1;
  }

  return out.join("\n");
}
