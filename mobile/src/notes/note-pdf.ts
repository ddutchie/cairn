/**
 * Convert a note's markdown into a self-contained HTML document for PDF export
 * on mobile. markdown-it (already a transitive dep via
 * react-native-markdown-display) renders standard markdown; Cairn callouts and
 * wikilinks are converted to the same HTML the desktop PDF template styles, so
 * mobile PDFs match desktop.
 *
 * Pipeline: calloutsToHtml -> wikilinksToChips (outside callouts) -> markdown-it
 * (html:true) -> wrap in buildPdfHtml.
 */
import { buildPdfHtml, type PdfTheme } from "@cairn/shared/notes/pdf-template";
import { calloutsToHtml, wikilinksToChips } from "@cairn/shared/notes/note-html";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

// markdown-it has no bundled @types here; require + minimal typing. These use
// require (not import) because the packages ship no ESM/type entrypoint in this
// RN toolchain — kept below the ESM imports to satisfy import/first.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const MarkdownIt = require("markdown-it") as new (opts?: Record<string, unknown>) => {
  render(src: string): string;
  use(plugin: unknown): unknown;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const markdownItMark = require("markdown-it-mark");

const md = new MarkdownIt({ html: true, linkify: true, breaks: false });
md.use(markdownItMark);

/** Render note markdown to a full PDF-ready HTML document. */
export function noteMarkdownToPdfHtml(title: string, markdown: string, theme: PdfTheme = "light"): string {
  // 1. Callout blocks -> [data-callout] HTML (also chips wikilinks inside them).
  const withCallouts = calloutsToHtml(markdown ?? "");
  // 2. Wikilinks in the remaining (non-callout) markdown -> chips. The callout
  //    HTML already chipped its own; the wrapper divs contain no [[…]] so this
  //    pass only touches ordinary text.
  const withWikilinks = wikilinksToChips(withCallouts);
  // 3. Render markdown (html:true lets our injected HTML pass through).
  const body = md.render(withWikilinks);
  // 4. Wrap in the shared template.
  return buildPdfHtml(title, body, theme);
}

export type PdfExportResult =
  | { ok: true; shared: boolean }
  | { ok: false; error: string };

/**
 * Generate a PDF from a note's markdown and open the system share sheet
 * (which includes Print / Save to Files / AirDrop on iOS). Mirrors the desktop
 * "export as PDF" intent. `theme` should follow the app's current colour scheme.
 */
export async function exportNoteToPdf(
  title: string,
  markdown: string,
  theme: PdfTheme = "light",
): Promise<PdfExportResult> {
  try {
    const html = noteMarkdownToPdfHtml(title, markdown, theme);
    const { uri } = await Print.printToFileAsync({ html });
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, {
        mimeType: "application/pdf",
        dialogTitle: title,
        UTI: "com.adobe.pdf",
      });
      return { ok: true, shared: true };
    }
    // Sharing unavailable (rare) — the PDF still exists at `uri`.
    return { ok: true, shared: false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
