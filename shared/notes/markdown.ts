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
