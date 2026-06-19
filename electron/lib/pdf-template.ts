/**
 * Pure HTML template builder for PDF export.
 *
 * Extracted from the inline `app:exportNotePdf` IPC handler so the styles can be
 * edited in one place and the template is unit-testable in isolation.
 *
 * The PDF is a self-contained document using the same `prose-cairn` class names
 * the renderer uses, so the resulting PDF visually matches what the user sees
 * in Cairn. Supports both light and dark themes.
 *
 * @param title - document title; scrubbed for HTML injection (we only allow text)
 * @param htmlBody - already-rendered HTML body content (from the markdown pipeline)
 * @param theme - "light" (default) or "dark"
 */
export type PdfTheme = "light" | "dark";

const LIGHT_VARS = {
  bg: "#ffffff",
  textPrimary: "#1a1917",
  textSecondary: "#4a4744",
  surface2: "#f0eeeb",
  border: "#dddad6",
  accent: "#6457e8",
  codeBg: "#f8f7f5",
  codeColor: "#374151",
  success: "#16a34a",
  warning: "#d97706",
  danger: "#dc2626",
};

const DARK_VARS = {
  bg: "#141414",
  textPrimary: "#e8e4dc",
  textSecondary: "#9e9a94",
  surface2: "#1a1a1a",
  border: "#2a2a2a",
  accent: "#7c6af7",
  codeBg: "#1e1e1e",
  codeColor: "#abb2bf",
  success: "#98c379",
  warning: "#e5c07b",
  danger: "#e06c75",
};

export function buildPdfHtml(title: string, htmlBody: string, theme: PdfTheme = "light"): string {
  const v = theme === "dark" ? DARK_VARS : LIGHT_VARS;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title.replace(/</g, "&lt;")}</title>
<style>
*, *::before, *::after { box-sizing: border-box; }
:root {
  --text-primary: ${v.textPrimary};
  --text-secondary: ${v.textSecondary};
  --surface: ${v.bg};
  --surface-2: ${v.surface2};
  --border: ${v.border};
  --accent: ${v.accent};
  --code-bg: ${v.codeBg};
  --code-color: ${v.codeColor};
  --success: ${v.success};
  --warning: ${v.warning};
  --danger: ${v.danger};
}
@page {
  size: A4;
  margin: 2cm 2.2cm;
${theme === "dark" ? `  background: ${v.bg};` : ""}
}
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: ${v.bg};
  color: ${v.textPrimary};
  /* Ensure nothing overflows the page width */
  max-width: 100%;
  overflow-x: hidden;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
.prose-cairn { color: var(--text-primary); font-size: 0.875rem; line-height: 1.7; }
.prose-cairn h1 { font-size: 1.5rem; font-weight: 700; margin: 1.25rem 0 0.5rem; color: var(--text-primary); }
.prose-cairn h2 { font-size: 1.2rem; font-weight: 600; margin: 1rem 0 0.4rem; color: var(--text-primary); }
.prose-cairn h3 { font-size: 1rem; font-weight: 600; margin: 0.75rem 0 0.3rem; color: var(--text-primary); }
.prose-cairn p { margin: 0.5rem 0; word-wrap: break-word; overflow-wrap: break-word; }
.prose-cairn strong { font-weight: 600; }
.prose-cairn em { font-style: italic; }
.prose-cairn code { font-family: ui-monospace, monospace; font-size: 0.8em; background: var(--surface-2); border: 1px solid var(--border); border-radius: 3px; padding: 0.1em 0.35em; word-break: break-all; }
/* Code blocks: overflow wraps rather than clips */
.prose-cairn pre { margin: 0.75rem 0; padding: 0.75rem 1rem; background: var(--code-bg) !important; color: var(--code-color) !important; border: 1px solid var(--border); border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; word-break: break-all; max-width: 100%; }
.prose-cairn pre code { background: none !important; border: none; padding: 0; font-size: 0.8rem; white-space: pre-wrap; word-break: break-all; }
.prose-cairn ul { list-style: disc; padding-left: 1.5rem; margin: 0.5rem 0; }
.prose-cairn ol { list-style: decimal; padding-left: 1.5rem; margin: 0.5rem 0; }
.prose-cairn li { margin: 0.2rem 0; }
.prose-cairn blockquote { border-left: 3px solid var(--accent); margin: 0.75rem 0; padding: 0.25rem 0 0.25rem 1rem; color: var(--text-secondary); }
.prose-cairn hr { border: none; border-top: 1px solid var(--border); margin: 1rem 0; }
.prose-cairn a { color: var(--accent); text-decoration: underline; word-break: break-all; }
.prose-cairn table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin: 0.75rem 0; table-layout: fixed; word-wrap: break-word; }
.prose-cairn th { background: var(--surface-2); font-weight: 600; text-align: left; padding: 0.4rem 0.6rem; border: 1px solid var(--border); word-wrap: break-word; }
.prose-cairn td { padding: 0.35rem 0.6rem; border: 1px solid var(--border); word-wrap: break-word; }
.prose-cairn tr:nth-child(even) td { background: var(--surface-2); }
/* Wikilink chips */
.wikilink-chip { display: inline-flex; align-items: center; gap: 3px; color: var(--accent); font-size: 0.85em; }
/* Callout blocks — the React <Callout> component emits inline styles using
 * color-mix() against CSS vars that don't all exist in this template (e.g.
 * --success, --warning). We define those vars here and add a stable
 * [data-callout] selector that overrides the inline styles with print-safe
 * equivalents, so callouts render with the correct colour per type. */
.prose-cairn [data-callout] {
  border: 1px solid var(--border);
  border-left-width: 3px;
  border-radius: 6px;
  margin: 0.75rem 0;
  overflow: hidden;
  page-break-inside: avoid;
}
/* Hide the header icon span (lucide SVG) in print — it doesn't always render
 * correctly in printToPDF and the title text is sufficient. */
.prose-cairn [data-callout] > div:first-child > span:first-child { display: none; }
.prose-cairn [data-callout] > div:first-child {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 0.786rem;
  font-weight: 600;
}
.prose-cairn [data-callout] > div:last-child {
  padding: 0 12px 10px;
  font-size: 0.875rem;
  color: var(--text-secondary);
}
/* Hide the collapse chevron — not interactive in a PDF */
.prose-cairn [data-callout] svg { display: none; }
/* Per-type accent colours (border-left + header text + tinted background).
 * The app uses color-mix(in srgb, var(--type-color) 8%, var(--surface));
 * we approximate that with a pre-computed tint per theme. Inline styles on
 * the <Callout> div use color-mix() which Chromium printToPDF may not fully
 * resolve, so we force our background with !important to override. */
.prose-cairn [data-callout] { background: var(--surface-2) !important; }
.prose-cairn [data-callout-type="note"],
.prose-cairn [data-callout-type="info"]    { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--surface)) !important; }
.prose-cairn [data-callout-type="note"] > div:first-child,
.prose-cairn [data-callout-type="info"] > div:first-child    { color: var(--accent); }
.prose-cairn [data-callout-type="tip"]     { border-left-color: var(--success); background: color-mix(in srgb, var(--success) 8%, var(--surface)) !important; }
.prose-cairn [data-callout-type="tip"] > div:first-child     { color: var(--success); }
.prose-cairn [data-callout-type="warning"] { border-left-color: var(--warning); background: color-mix(in srgb, var(--warning) 8%, var(--surface)) !important; }
.prose-cairn [data-callout-type="warning"] > div:first-child { color: var(--warning); }
.prose-cairn [data-callout-type="danger"],
.prose-cairn [data-callout-type="caution"] { border-left-color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, var(--surface)) !important; }
.prose-cairn [data-callout-type="danger"] > div:first-child,
.prose-cairn [data-callout-type="caution"] > div:first-child { color: var(--danger); }
.prose-cairn [data-callout-type="success"],
.prose-cairn [data-callout-type="check"],
.prose-cairn [data-callout-type="done"]    { border-left-color: var(--success); background: color-mix(in srgb, var(--success) 8%, var(--surface)) !important; }
.prose-cairn [data-callout-type="success"] > div:first-child,
.prose-cairn [data-callout-type="check"] > div:first-child,
.prose-cairn [data-callout-type="done"] > div:first-child    { color: var(--success); }
.prose-cairn [data-callout-type="question"],
.prose-cairn [data-callout-type="faq"]     { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--surface)) !important; }
.prose-cairn [data-callout-type="question"] > div:first-child,
.prose-cairn [data-callout-type="faq"] > div:first-child     { color: var(--accent); }
.prose-cairn [data-callout-type="quote"],
.prose-cairn [data-callout-type="cite"]    { border-left-color: var(--text-secondary); background: var(--surface-2) !important; }
.prose-cairn [data-callout-type="quote"] > div:first-child,
.prose-cairn [data-callout-type="cite"] > div:first-child   { color: var(--text-secondary); }
/* Page break hints */
h1, h2, h3 { page-break-after: avoid; }
pre, blockquote, table { page-break-inside: avoid; }
/* Note title at top of PDF */
.pdf-title { font-size: 1.75rem; font-weight: 700; margin: 0 0 1.5rem; color: var(--text-primary); }
</style>
</head>
<body>
<h1 class="pdf-title">${title.replace(/</g, "&lt;")}</h1>
<div class="prose-cairn">${htmlBody}</div>
</body>
</html>`;
}
