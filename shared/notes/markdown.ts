/**
 * Shared markdown preprocessing for Cairn-specific syntax — used to bring the
 * mobile renderer (react-native-markdown-display, markdown-it based) toward
 * parity with the desktop remark pipeline.
 *
 * Desktop uses remark plugins for these; RN's markdown-it doesn't, so we
 * rewrite the syntax into standard markdown that the RN renderer + custom
 * link/blockquote rules can handle:
 *
 *   [[Title]]        -> [Title](cairn://note/<id or encoded title>)   (wikilink)
 *   ![[image.png]]   -> _(image: image.png)_                    (embed, out of MVP)
 *   > [!type] Title  -> left intact; the caller styles blockquotes as callouts
 *
 * A wikilink can resolve to either a NOTE or a CARD. When a `resolveWikilink`
 * hook is supplied (chat, where the local DB is available) the concrete id is
 * baked into the URL at preprocess time — matching desktop and making tap-time
 * navigation deterministic (no title re-matching, no rename drift, no
 * LIMIT-1 collision misrouting). Without the hook (plain note bodies) it falls
 * back to encoding the title into a `cairn://note/` URL, resolved on tap.
 */

/** Matches `[[Title]]` — group 1 is the (untrimmed) title. */
export const WIKILINK_RE = /\[\[([^\][\n]+?)\]\]/g;

/** Matches an Obsidian embed `![[target]]` — group 1 is the target. */
export const EMBED_RE = /!\[\[([^\][\n]+?)\]\]/g;

/** Scheme used for internal note navigation (intercepted by onLinkPress). */
export const CAIRN_NOTE_SCHEME = "cairn://note/";

/** Scheme used for internal card/task navigation (intercepted by onLinkPress). */
export const CAIRN_CARD_SCHEME = "cairn://task/";

/** Result of resolving a wikilink title against the local data. */
export interface WikilinkTarget {
  kind: "note" | "card";
  id: string;
  /** Canonical title to render as the link label (defaults to the raw title). */
  title?: string;
}

/**
 * Resolve a wikilink title to a concrete note/card id, or null if unknown.
 * Supplied by the caller (mobile chat) so ids are baked in at preprocess time.
 */
export type WikilinkResolver = (title: string) => WikilinkTarget | null;

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
 *
 * When `resolve` is supplied, each `[[Title]]` is resolved to a concrete
 * note/card id and the id is baked into the URL (`cairn://note/<id>` or
 * `cairn://task/<id>`). Titles that don't resolve fall back to a title-encoded
 * `cairn://note/` URL (tap-time resolution). Without `resolve`, every wikilink
 * uses the title-encoded note form.
 */
export function preprocessCairnMarkdown(src: string, resolve?: WikilinkResolver): string {
  if (!src) return "";
  let out = src;

  // ![[embed]] -> italic placeholder (binary assets are out of the mobile MVP).
  out = out.replace(EMBED_RE, (_all, target: string) => `_(embed: ${target.trim()})_`);

  // [[Title]] -> [label](cairn://note|task/<id or encoded title>)
  out = out.replace(WIKILINK_RE, (_all, title: string) => {
    const t = title.trim();
    const target = resolve?.(t) ?? null;
    if (target) {
      const scheme = target.kind === "card" ? CAIRN_CARD_SCHEME : CAIRN_NOTE_SCHEME;
      const label = target.title ?? t;
      return `[${label}](${scheme}${encodeURIComponent(target.id)})`;
    }
    return `[${t}](${CAIRN_NOTE_SCHEME}${encodeURIComponent(t)})`;
  });

  return out;
}

/** If a tapped URL is an internal note wikilink, return the decoded value. */
export function noteTitleFromUrl(url: string): string | null {
  if (!url.startsWith(CAIRN_NOTE_SCHEME)) return null;
  try {
    return decodeURIComponent(url.slice(CAIRN_NOTE_SCHEME.length));
  } catch {
    return url.slice(CAIRN_NOTE_SCHEME.length);
  }
}

/** If a tapped URL is an internal card/task wikilink, return the decoded value. */
export function cardIdFromUrl(url: string): string | null {
  if (!url.startsWith(CAIRN_CARD_SCHEME)) return null;
  try {
    return decodeURIComponent(url.slice(CAIRN_CARD_SCHEME.length));
  } catch {
    return url.slice(CAIRN_CARD_SCHEME.length);
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
