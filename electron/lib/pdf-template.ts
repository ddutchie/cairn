/**
 * Pure HTML template builder for PDF export.
 *
 * Extracted from the inline `app:exportNotePdf` IPC handler so the styles can be
 * edited in one place and the template is unit-testable in isolation.
 *
 * The PDF is a self-contained light-theme document (regardless of the app's
 * current theme) using the same `prose-cairn` class names the renderer uses,
 * so the resulting PDF visually matches what the user sees in Cairn.
 *
 * @param title - document title; scrubbed for HTML injection (we only allow text)
 * @param htmlBody - already-rendered HTML body content (from the markdown pipeline)
 */
export function buildPdfHtml(title: string, htmlBody: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title.replace(/</g, "&lt;")}</title>
<style>
*, *::before, *::after { box-sizing: border-box; }
:root {
  --text-primary: #1a1917;
  --text-secondary: #4a4744;
  --surface-2: #f0eeeb;
  --border: #dddad6;
  --accent: #6457e8;
}
@page {
  size: A4;
  margin: 2cm 2.2cm;
}
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #ffffff;
  color: #1a1917;
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
.prose-cairn pre { margin: 0.75rem 0; padding: 0.75rem 1rem; background: var(--surface-2) !important; color: #374151 !important; border: 1px solid var(--border); border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; word-break: break-all; max-width: 100%; }
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
/* Callout blocks */
.callout { border-left: 3px solid var(--accent); background: var(--surface-2); padding: 0.5rem 0.75rem; margin: 0.75rem 0; border-radius: 0 4px 4px 0; }
/* Page break hints */
h1, h2, h3 { page-break-after: avoid; }
pre, blockquote, table { page-break-inside: avoid; }
</style>
</head>
<body>
<div class="prose-cairn">${htmlBody}</div>
</body>
</html>`;
}
