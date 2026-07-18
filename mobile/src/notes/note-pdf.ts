/**
 * Convert a note's markdown into a self-contained HTML document for PDF export
 * on mobile. markdown-it (already a transitive dep via
 * react-native-markdown-display) renders standard markdown; Cairn callouts and
 * wikilinks are converted to the same HTML the desktop PDF template styles, so
 * mobile PDFs match desktop.
 *
 * Security + correctness of the pipeline:
 *   - markdown-it runs with `html: false`, so ANY raw HTML a user typed into
 *     their note is neutralised (escaped) rather than passed to Expo Print.
 *   - Our OWN trusted fragments (callout wrappers, wikilink chips) are injected
 *     via opaque sentinel placeholders that survive markdown-it untouched, then
 *     swapped back to real HTML after rendering — so only the fragments WE
 *     generate become live HTML, never arbitrary note content.
 *   - Cairn transforms run only OUTSIDE fenced/inline code (transformOutsideCode
 *     + code-aware calloutsToHtml), so `[[x]]` / `> [!note]` inside code render
 *     literally.
 *
 * Pipeline: calloutsToHtml (code-aware) -> chip wikilinks outside code ->
 * fragments to sentinels -> markdown-it (html:false) -> sentinels back to HTML
 * -> wrap in buildPdfHtml.
 */
import { buildPdfHtml, type PdfTheme, pdfSafeFilename } from "@cairn/shared/notes/pdf-template";
import { calloutsToHtml, wikilinksToChips, transformOutsideCode } from "@cairn/shared/notes/note-html";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";

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

// html:false — user-authored raw HTML is escaped, not emitted. Our trusted
// fragments reach the output only via the sentinel swap below.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
md.use(markdownItMark);

// Opaque, collision-proof sentinel wrapping a trusted HTML fragment. Uses
// private-use unicode + a random token so it cannot appear in note content or
// be produced by markdown-it escaping. Captured group is the fragment index.
const SENTINEL_TAG = `\uE000CAIRN${Math.random().toString(36).slice(2, 10)}`;
const SENTINEL_RE = new RegExp(`${SENTINEL_TAG}(\\d+)\uE001`, "g");

/** Render note markdown to a full PDF-ready HTML document. */
export function noteMarkdownToPdfHtml(title: string, markdown: string, theme: PdfTheme = "light"): string {
  const fragments: string[] = [];
  const stash = (html: string): string => `${SENTINEL_TAG}${fragments.push(html) - 1}\uE001`;

  // 1. Callout blocks -> trusted [data-callout] HTML (code-aware; also chips
  //    wikilinks inside their bodies). Stash each block behind a sentinel.
  const withCallouts = calloutsToHtml(markdown ?? "").replace(
    /<div data-callout[\s\S]*?<\/div><\/div>/g,
    (block) => stash(block),
  );
  // 2. Wikilinks in the remaining (non-callout, non-code) markdown -> chips,
  //    each stashed behind a sentinel so markdown-it can't touch the HTML.
  const withWikilinks = transformOutsideCode(withCallouts, (text) =>
    wikilinksToChips(text).replace(/<span class="wikilink-chip">[\s\S]*?<\/span>/g, (chip) => stash(chip)),
  );
  // 3. Render markdown with raw HTML disabled — user HTML is escaped here.
  const rendered = md.render(withWikilinks);
  // 4. Swap our trusted fragments back in.
  const body = rendered.replace(SENTINEL_RE, (_all, idx: string) => fragments[Number(idx)] ?? "");
  // 5. Wrap in the shared template.
  return buildPdfHtml(title, body, theme);
}

export type PdfExportResult =
  | { ok: true; shared: true }
  | { ok: true; shared: false; fileUri: string }
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

    // Print writes to a random cache filename; rename it to the note title so
    // the shared/saved PDF is "<Title>.pdf". Best-effort — if the move fails
    // for any reason we still share the original file.
    let shareUri = uri;
    try {
      const named = new File(Paths.cache, `${pdfSafeFilename(title)}.pdf`);
      if (named.exists) named.delete(); // avoid DestinationAlreadyExists on repeat exports
      const src = new File(uri);
      src.moveSync(named);
      shareUri = named.uri;
    } catch {
      /* keep the original uri */
    }

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(shareUri, {
        mimeType: "application/pdf",
        dialogTitle: title,
        UTI: "com.adobe.pdf",
      });
      return { ok: true, shared: true };
    }
    // Sharing unavailable (rare) — return the file's uri so the caller can still
    // surface / open it, rather than reporting a bare success with no handle.
    return { ok: true, shared: false, fileUri: shareUri };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
