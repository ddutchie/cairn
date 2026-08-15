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
import { CELL_CHECKBOX_RE } from "@cairn/shared/notes/markdown";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";

// Minimal structural types for markdown-it tokens used by tableCheckboxPlugin
// (markdown-it ships no @types in this RN toolchain).
interface MdItToken {
  type: string;
  content: string;
  meta?: { checked?: boolean } | null;
  children?: MdItToken[] | null;
  constructor: MdItTokenCtor;
}
type MdItTokenCtor = new (type: string, tag: string, nesting: number) => MdItToken;

// markdown-it has no bundled @types here; require + minimal typing. These use
// require (not import) because the packages ship no ESM/type entrypoint in this
// RN toolchain — kept below the ESM imports to satisfy import/first.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const MarkdownIt = require("markdown-it") as new (opts?: Record<string, unknown>) => {
  render(src: string): string;
  use(plugin: unknown): unknown;
  core: { ruler: { after: (a: string, n: string, fn: (state: { tokens: MdItToken[] }) => boolean) => void } };
  renderer: { rules: Record<string, (tokens: MdItToken[], idx: number) => string> };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const markdownItMark = require("markdown-it-mark");

// html:false — user-authored raw HTML is escaped, not emitted. Our trusted
// fragments reach the output only via the sentinel swap below.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
md.use(markdownItMark);
md.use(tableCheckboxPlugin);

/**
 * markdown-it plugin: recover GFM task-list checkboxes crammed into table cells.
 *
 * GFM only parses inline content inside cells, so a whole checklist
 * (`- [ ] a<br>- [x] b`) survives as a literal text token. With `html:false`
 * the `<br>` and `[ ]` would render as visible text. This core rule walks each
 * table cell's inline token, splits its text on the checkbox grammar, and
 * replaces it with `cairn_checkbox` tokens (rendered as a real checkbox glyph)
 * and `html_inline` line breaks. Custom token renderers emit HTML regardless of
 * the `html:false` flag, so no arbitrary user HTML is enabled by this.
 */
function tableCheckboxPlugin(mdInstance: {
  core: { ruler: { after: (a: string, n: string, fn: (state: { tokens: MdItToken[] }) => boolean) => void } };
  renderer: { rules: Record<string, (tokens: MdItToken[], idx: number) => string> };
}): void {
  mdInstance.renderer.rules.cairn_checkbox = (tokens, idx) => {
    const checked = tokens[idx].meta?.checked === true;
    // Static (non-interactive) checkbox glyph for print. Matches list checkboxes.
    return checked
      ? '<span class="cairn-cb cairn-cb-on">\u2611</span> '
      : '<span class="cairn-cb">\u2610</span> ';
  };

  mdInstance.core.ruler.after("inline", "cairn_table_checkboxes", (state) => {
    const tokens = state.tokens;
    let inCell = false;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.type === "td_open" || tok.type === "th_open") { inCell = true; continue; }
      if (tok.type === "td_close" || tok.type === "th_close") { inCell = false; continue; }
      if (!inCell || tok.type !== "inline") continue;

      const raw = tok.content;
      const re = new RegExp(CELL_CHECKBOX_RE.source, CELL_CHECKBOX_RE.flags);
      if (!re.test(raw)) continue;
      re.lastIndex = 0;

      const newChildren: MdItToken[] = [];
      const pushText = (text: string) => {
        // Convert literal <br> to a hardbreak token so cell checklists wrap.
        const parts = text.split(/<br\s*\/?>/i);
        parts.forEach((part, pi) => {
          if (part) {
            const t = new (tok.constructor as MdItTokenCtor)("text", "", 0);
            t.content = part;
            newChildren.push(t);
          }
          if (pi < parts.length - 1) {
            newChildren.push(new (tok.constructor as MdItTokenCtor)("hardbreak", "br", 0));
          }
        });
      };

      let lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) {
        const lead = m[1] ?? "";
        const boundary = /^<br/i.test(lead) ? "<br>" : lead;
        pushText(raw.slice(lastIndex, m.index) + boundary);
        const cb = new (tok.constructor as MdItTokenCtor)("cairn_checkbox", "", 0);
        cb.meta = { checked: m[3].toLowerCase() === "x" };
        newChildren.push(cb);
        lastIndex = re.lastIndex;
      }
      pushText(raw.slice(lastIndex));

      tok.children = newChildren;
    }
    return true;
  });
}


// Opaque, collision-proof sentinel wrapping a trusted HTML fragment. Uses
// private-use unicode + a random token so it cannot appear in note content or
// be produced by markdown-it escaping. Captured group is the fragment index.
const SENTINEL_TAG = `\uE000CAIRN${Math.random().toString(36).slice(2, 10)}`;
const SENTINEL_RE = new RegExp(`${SENTINEL_TAG}(\\d+)\uE001`, "g");

/** Render note markdown to a full PDF-ready HTML document. */
export function noteMarkdownToPdfHtml(
  title: string,
  markdown: string,
  theme: PdfTheme = "light",
  fontFamily?: string,
): string {
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
  return buildPdfHtml(title, body, theme, "heading", fontFamily);
}

export type PdfExportResult =
  | { ok: true; shared: true }
  | { ok: true; shared: false; fileUri: string }
  | { ok: false; error: string };

/**
 * Generate a PDF from a note's markdown and open the system share sheet
 * (which includes Print / Save to Files / AirDrop on iOS). Mirrors the desktop
 * "export as PDF" intent. `theme` should follow the app's current colour scheme.
 * `fontFamily` is a CSS font-family stack for the note text (system fonts only —
 * bundled webfonts don't load in expo-print). Defaults to the platform sans.
 */
export async function exportNoteToPdf(
  title: string,
  markdown: string,
  theme: PdfTheme = "light",
  fontFamily?: string,
): Promise<PdfExportResult> {
  try {
    const html = noteMarkdownToPdfHtml(title, markdown, theme, fontFamily);
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
