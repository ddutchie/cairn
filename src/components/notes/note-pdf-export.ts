import { DARK_TO_LIGHT } from "@/lib/syntax-palette";

/**
 * Prepare captured note HTML for PDF export.
 *
 * `CodeBlock` renders with hardcoded inline styles derived from the active
 * theme. For a light PDF we rewrite those inline styles to the light palette
 * (background/border + per-token colours via the shared `DARK_TO_LIGHT` map)
 * and strip the Copy-button header (useless in print). For a dark PDF the code
 * blocks are already dark-themed, so we only remove the header.
 *
 * Pure DOM transform — takes the raw innerHTML and returns the processed HTML.
 * Extracted from `note-editor.tsx` so it can be tested in isolation.
 */
export function prepareNoteHtmlForPdf(rawHtml: string, theme: "light" | "dark"): string {
  const doc = new DOMParser().parseFromString(`<div>${rawHtml}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return rawHtml;

  // Each CodeBlock renders as: div.my-4.rounded-lg > div(header) + pre
  for (const block of root.querySelectorAll<HTMLElement>("div.my-4")) {
    const pre = block.querySelector<HTMLElement>("pre");
    const header = block.querySelector<HTMLElement>("div");
    if (!pre) continue;

    if (theme === "light") {
      // Force light-theme colours on pre and its border container
      pre.style.background = "#f8f7f5";
      pre.style.color      = "#374151";
      block.style.border   = "1px solid #dddad6";

      // Rewrite token span colours from the dark palette → light palette
      for (const span of pre.querySelectorAll<HTMLElement>("span[style]")) {
        const c = span.style.color.toLowerCase();
        if (DARK_TO_LIGHT[c]) span.style.color = DARK_TO_LIGHT[c];
      }
    }

    // Remove the Copy button header — not useful in print
    if (header) header.remove();
  }

  return root.innerHTML;
}

/** Sanitise a note title into a filesystem-safe base filename. */
export function pdfSafeTitle(title: string): string {
  return title.replace(/[\/\\:*?"<>|]/g, "_").trim() || "untitled";
}
