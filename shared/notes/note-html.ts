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

/**
 * Run a transform over the NON-CODE regions of markdown only, leaving fenced
 * code blocks (```lang … ```  or ~~~ … ~~~) and inline code spans (`…`)
 * byte-for-byte untouched. Used so Cairn syntax transforms (wikilinks, callout
 * detection) never rewrite `[[…]]` or `> [!note]` that appear inside code, where
 * they must render literally.
 */
export function transformOutsideCode(src: string, fn: (text: string) => string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let fence: string | null = null; // active fence marker (``` or ~~~) or null

  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      out.push(line); // inside a fenced block — verbatim
      if (fenceMatch && line.trimStart().startsWith(fence)) fence = null; // closing fence
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1].startsWith("`") ? "```" : "~~~";
      out.push(line); // the opening fence line itself is code
      continue;
    }
    // Ordinary line: transform, but skip inline-code spans (`…`).
    out.push(transformOutsideInlineCode(line, fn));
  }
  return out.join("\n");
}

/** Apply `fn` to a line's text but not to its inline-code spans (`…`). */
function transformOutsideInlineCode(line: string, fn: (text: string) => string): string {
  // Split on backtick-delimited spans, keeping the delimiters. Odd indices are
  // code spans (untouched); even indices are ordinary text (transformed).
  const parts = line.split(/(`+[^`]*`+)/);
  return parts.map((p, i) => (i % 2 === 1 ? p : fn(p))).join("");
}


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
 * Like `wikilinksToChips`, but for RAW (un-escaped) text: HTML-escapes the
 * ordinary text between wikilinks AND each wikilink title, each exactly once.
 *
 * Use this when the text will NOT be handed to a markdown renderer afterwards
 * (e.g. a callout body). The plain `wikilinksToChips` leaves surrounding text
 * raw for markdown-it to handle; calling it on already-escaped text would
 * double-escape a title like `[[a<b>]]` (→ `&amp;lt;`). This single-pass variant
 * avoids that.
 */
export function escapeAndChipWikilinks(text: string): string {
  let out = "";
  let last = 0;
  WIKILINK_RE.lastIndex = 0;
  for (let m = WIKILINK_RE.exec(text); m; m = WIKILINK_RE.exec(text)) {
    out += escapeHtml(text.slice(last, m.index)); // ordinary text: escaped once
    out += `<span class="wikilink-chip">${escapeHtml(m[1].trim())}</span>`; // title: escaped once
    last = m.index + m[0].length;
  }
  out += escapeHtml(text.slice(last));
  return out;
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
  let fence: string | null = null; // active fenced-code marker or null

  while (i < lines.length) {
    const line = lines[i];
    // Track fenced code blocks so a `> [!note]` INSIDE code isn't turned into a
    // callout (it must render literally).
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      out.push(line);
      if (fenceMatch && line.trimStart().startsWith(fence)) fence = null;
      i += 1;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1].startsWith("`") ? "```" : "~~~";
      out.push(line);
      i += 1;
      continue;
    }
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
        .map((l) => escapeAndChipWikilinks(l))
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
