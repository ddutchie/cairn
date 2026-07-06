/**
 * Shared markdown preprocessing for Cairn-specific syntax — used to bring the
 * mobile renderer (react-native-markdown-display, markdown-it based) toward
 * parity with the desktop remark pipeline.
 *
 * Desktop uses remark plugins for these; RN's markdown-it doesn't, so we
 * rewrite the syntax into standard markdown that the RN renderer + custom
 * link/blockquote rules can handle:
 *
 *   [[Title]]        -> [Title](cairn://note/<encoded title>)   (wikilink)
 *   ![[image.png]]   -> _(image: image.png)_                    (embed, out of MVP)
 *   > [!type] Title  -> left intact; the caller styles blockquotes as callouts
 */

/** Matches `[[Title]]` — group 1 is the (untrimmed) title. */
export const WIKILINK_RE = /\[\[([^\][\n]+?)\]\]/g;

/** Matches an Obsidian embed `![[target]]` — group 1 is the target. */
export const EMBED_RE = /!\[\[([^\][\n]+?)\]\]/g;

/** Scheme used for internal wikilink navigation (intercepted by onLinkPress). */
export const CAIRN_NOTE_SCHEME = "cairn://note/";

export interface CalloutMeta {
  type: string;
  title?: string;
}

/** Parse a callout header line `[!type] Optional Title` → meta, or null. */
export function parseCalloutHeader(firstLine: string): CalloutMeta | null {
  const m = /^\s*\[!([^\]]+)\]\s*(.*)$/.exec(firstLine);
  if (!m) return null;
  return { type: m[1].trim().toLowerCase(), title: m[2]?.trim() || undefined };
}

/**
 * Rewrite Cairn syntax to standard markdown for the mobile renderer.
 * Embeds are handled BEFORE wikilinks (the `!` prefix must win).
 */
export function preprocessCairnMarkdown(src: string): string {
  if (!src) return "";
  let out = src;

  // ![[embed]] -> italic placeholder (binary assets are out of the mobile MVP).
  out = out.replace(EMBED_RE, (_all, target: string) => `_(embed: ${target.trim()})_`);

  // [[Title]] -> [Title](cairn://note/<encoded>)
  out = out.replace(WIKILINK_RE, (_all, title: string) => {
    const t = title.trim();
    return `[${t}](${CAIRN_NOTE_SCHEME}${encodeURIComponent(t)})`;
  });

  return out;
}

/** If a tapped URL is an internal wikilink, return the decoded note title. */
export function noteTitleFromUrl(url: string): string | null {
  if (!url.startsWith(CAIRN_NOTE_SCHEME)) return null;
  try {
    return decodeURIComponent(url.slice(CAIRN_NOTE_SCHEME.length));
  } catch {
    return url.slice(CAIRN_NOTE_SCHEME.length);
  }
}

/**
 * Matches a CSS colour literal in its entirety (hex 3/4/6/8, or rgb(a)/hsl(a)).
 * Used to render an inline colour swatch beside colour-valued inline code —
 * mirrors the desktop `InlineCode` COLOR_RE.
 */
export const COLOR_RE =
  /^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(rgba?|hsla?)\s*\([^)]+\))$/;

/** True when `text` is exactly a CSS colour literal. */
export function isColorLiteral(text: string): boolean {
  return COLOR_RE.test(text.trim());
}

/**
 * Toggle the Nth rendered task-list checkbox in a markdown source string.
 *
 * Shared with the desktop editor (was note-editor-utils.ts). Scans line by line
 * so it can distinguish list-marker checkboxes (one per line, at the start) from
 * table-cell checkboxes (several per line, inside `| … |`). `index` is the
 * zero-based order in which checkboxes render.
 */
export function toggleCheckboxInSource(source: string, index: number): string {
  if (index < 0) return source;

  const listLineRe = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/;
  const tableRowRe = /^\s*\|.*\|/;
  const cellLeadingRe = /^(\s*)\[([ xX])\]/;

  let seen = 0;
  let changed = false;

  const lines = source.split("\n").map((line) => {
    if (changed) return line;

    if (listLineRe.test(line)) {
      if (seen === index) {
        changed = true;
        return line.replace(listLineRe, (full) =>
          full.replace(/\[([ xX])\]/, (_m, state: string) => (state === " " ? "[x]" : "[ ]")),
        );
      }
      seen += 1;
      return line;
    }

    if (tableRowRe.test(line)) {
      const cells = line.split("|");
      let lineChanged = false;
      const newCells = cells.map((cell) => {
        if (changed) return cell;
        const cm = cell.match(cellLeadingRe);
        if (!cm) return cell;
        if (seen === index) {
          seen += 1;
          changed = true;
          lineChanged = true;
          const next = cm[2] === " " ? "[x]" : "[ ]";
          return cell.replace(cellLeadingRe, `${cm[1]}${next}`);
        }
        seen += 1;
        return cell;
      });
      return lineChanged ? newCells.join("|") : line;
    }

    return line;
  });

  return changed ? lines.join("\n") : source;
}
