/**
 * Text transforms that adapt Cairn's markdown to the native renderer
 * (react-native-enriched-markdown), which supports a narrower syntax than the
 * markdown-it pipeline. All of them leave fenced code and inline code untouched.
 */

export type GithubAlert = "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION";

/** Obsidian callout type → the closest GitHub alert, which the native renderer draws. */
const ALERT_FOR: Record<string, GithubAlert> = {
  note: "NOTE", info: "NOTE", abstract: "NOTE", summary: "NOTE", tldr: "NOTE", todo: "NOTE",
  question: "NOTE", help: "NOTE", faq: "NOTE", quote: "NOTE", cite: "NOTE", example: "NOTE",
  tip: "TIP", hint: "TIP", success: "TIP", check: "TIP", done: "TIP",
  important: "IMPORTANT",
  warning: "WARNING", attention: "WARNING",
  danger: "CAUTION", error: "CAUTION", failure: "CAUTION", fail: "CAUTION", missing: "CAUTION", bug: "CAUTION", caution: "CAUTION",
};

const GITHUB_NAMES = new Set(["note", "tip", "important", "warning", "caution"]);
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const CALLOUT_RE = /^(\s{0,3}>\s?)\[!([A-Za-z]+)\][+-]?[ \t]*(.*)$/;

/** Apply `fn` to every line outside a fenced code block. */
function mapOutsideFences(src: string, fn: (line: string) => string): string {
  let fence: string | null = null;
  return src
    .split("\n")
    .map((line) => {
      const m = FENCE_RE.exec(line);
      if (m) {
        if (fence === null) fence = m[1][0];
        else if (m[1][0] === fence) fence = null;
        return line;
      }
      return fence === null ? fn(line) : line;
    })
    .join("\n");
}

/**
 * `> [!question]- My title` → `> [!NOTE]` + a bold title line. GitHub alerts have a fixed label per
 * type, so the type name (when it isn't one of the five) and any custom title become the first line.
 */
export function calloutsToAlerts(src: string): string {
  return mapOutsideFences(src, (line) => {
    const m = CALLOUT_RE.exec(line);
    if (!m) return line;
    const [, prefix, rawType, rawTitle] = m;
    const type = rawType.toLowerCase();
    const alert = ALERT_FOR[type] ?? "NOTE";
    const title = rawTitle.trim() || (GITHUB_NAMES.has(type) ? "" : type[0].toUpperCase() + type.slice(1));
    const quote = prefix.trimEnd() === ">" ? prefix : `${prefix.trimEnd()} `;
    return title ? `${quote}[!${alert}]\n${quote.trimEnd()} **${title}**\n${quote.trimEnd()}` : `${quote}[!${alert}]`;
  });
}

/**
 * `||` always opens a spoiler in the native renderer, which would swallow it in ordinary text
 * (shell `||`, empty table cells excepted). Escape it outside code and table rows.
 */
export function escapeSpoilers(src: string): string {
  return mapOutsideFences(src, (line) => {
    if (!line.includes("||") || /^\s*\|/.test(line)) return line;
    // Leave inline code spans alone.
    return line
      .split(/(`+[^`]*`+)/)
      .map((part, i) => (i % 2 === 1 ? part : part.replace(/\|\|/g, "\\|\\|")))
      .join("");
  });
}

export type Segment =
  | { kind: "markdown"; text: string }
  | { kind: "mermaid"; code: string }
  | { kind: "image"; name: string };

const MERMAID_RE = /^```mermaid[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm;
const IMAGE_LINE_RE = /^[ \t]*!\[[^\]]*\]\(cairn:\/\/embed\/([^)\s]+)\)[ \t]*$/;

/**
 * Cut out what the native renderer can't draw: closed ```mermaid fences, and synced-image embeds
 * that sit on a line of their own (`![[name.png]]` after `preprocessCairnMarkdown`). An unclosed
 * fence stays in the markdown, so a diagram appears only once it has fully streamed.
 */
export function splitSegments(src: string): Segment[] {
  const out: Segment[] = [];
  const pushMarkdown = (text: string) => {
    let buf: string[] = [];
    const flush = () => {
      const text = buf.join("\n").replace(/^\n+|\n+$/g, "");
      if (text.trim()) out.push({ kind: "markdown", text });
      buf = [];
    };
    for (const line of text.split("\n")) {
      const m = IMAGE_LINE_RE.exec(line);
      if (m) {
        flush();
        let name = m[1];
        try { name = decodeURIComponent(name); } catch { /* keep raw */ }
        out.push({ kind: "image", name });
      } else {
        buf.push(line);
      }
    }
    flush();
  };

  let last = 0;
  MERMAID_RE.lastIndex = 0;
  for (let m = MERMAID_RE.exec(src); m; m = MERMAID_RE.exec(src)) {
    if (m.index > last) pushMarkdown(src.slice(last, m.index));
    out.push({ kind: "mermaid", code: m[1] });
    last = m.index + m[0].length;
  }
  if (last < src.length) pushMarkdown(src.slice(last));
  return out.length ? out : [{ kind: "markdown", text: src }];
}

/** An embed that shares a line with other text can't be split out; show its name instead of a broken image. */
export function inlineEmbedsToText(src: string): string {
  return src.replace(/!\[([^\]]*)\]\(cairn:\/\/embed\/[^)\s]+\)/g, (_all, alt: string) => `_(image: ${alt})_`);
}

const NOTE_LINK_RE = /\]\(cairn:\/\/note\/([^)\s]*)\)/g;

/** Re-point wikilinks that resolve to nothing at `cairn://dead/…` so they can be styled and ignored. */
export function markDeadWikilinks(src: string, deadTitles: ReadonlySet<string>): string {
  if (deadTitles.size === 0) return src;
  return src.replace(NOTE_LINK_RE, (all, enc: string) => {
    let title = enc;
    try { title = decodeURIComponent(enc); } catch { /* keep raw */ }
    return deadTitles.has(title) ? `](cairn://dead/${enc})` : all;
  });
}

// ── Colour literals ───────────────────────────────────────────────────────────

const COLOR_LITERAL_RE = /^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(rgba?|hsla?)\s*\([^)]+\))$/;
export const COLOR_SCHEME = "cairn://swatch/";

/** The distinct colour literals that `colorLiteralsToLinks` will chip, outside fenced blocks. */
export function findColorLiterals(src: string): string[] {
  const found = new Set<string>();
  const re = new RegExp(COLOR_OR_CODE_RE.source, "g");
  mapOutsideFences(src, (line) => {
    for (const m of line.matchAll(re)) {
      const literal = (m[1] ?? m[2] ?? "").trim();
      if (COLOR_LITERAL_RE.test(literal)) found.add(literal);
    }
    return line;
  });
  return [...found];
}

/**
 * A colour written in a reply gets a swatch: a `■` link to `cairn://swatch/…`, which a per-colour
 * link variant paints in that colour, followed by the colour as inline code. The native renderer
 * has no inline widgets, so a coloured glyph is the closest to the classic swatch. Covers inline code (`#ff0000`, any hex length) and bare
 * 6/8-digit hex and rgb()/hsl() calls in prose; bare 3-digit hex is left alone (`#123` is usually
 * an issue number).
 */
const COLOR_OR_CODE_RE =
  /`([^`\n]+)`|(?<![\w/&#%.-])(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})|(?:rgba?|hsla?)\([^)\n]+\))(?![\w%])/g;

export function colorLiteralsToLinks(src: string): string {
  return mapOutsideFences(src, (line) =>
    line.replace(COLOR_OR_CODE_RE, (all, code: string | undefined, bare: string | undefined) => {
      const literal = (code ?? bare ?? "").trim();
      return COLOR_LITERAL_RE.test(literal) ? `[■](${COLOR_SCHEME}${encodeURIComponent(literal)}) \`${literal}\`` : all;
    }),
  );
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
