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
export const COLOR_SCHEME = "cairn://color/";

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
 * A colour written in a reply becomes a `cairn://color/…` link, so a per-colour link variant can
 * paint it in that colour. The native renderer has no inline widgets, so a coloured chip is the
 * closest to the classic swatch. Covers inline code (`#ff0000`, any hex length) and bare
 * 6/8-digit hex and rgb()/hsl() calls in prose; bare 3-digit hex is left alone (`#123` is usually
 * an issue number).
 */
const COLOR_OR_CODE_RE =
  /`([^`\n]+)`|(?<![\w/&#%.-])(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})|(?:rgba?|hsla?)\([^)\n]+\))(?![\w%])/g;

export function colorLiteralsToLinks(src: string): string {
  return mapOutsideFences(src, (line) =>
    line.replace(COLOR_OR_CODE_RE, (all, code: string | undefined, bare: string | undefined) => {
      const literal = (code ?? bare ?? "").trim();
      return COLOR_LITERAL_RE.test(literal) ? `[${literal}](${COLOR_SCHEME}${encodeURIComponent(literal)})` : all;
    }),
  );
}

/** Parse a colour literal to 0–255 channels (alpha ignored), or null if it isn't one. */
export function parseColor(literal: string): [number, number, number] | null {
  const hex = /^#([0-9a-fA-F]+)$/.exec(literal);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const fn = /^(rgba?|hsla?)\s*\(([^)]+)\)$/.exec(literal);
  if (!fn) return null;
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean).map((p) => parseFloat(p));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  if (fn[1].startsWith("rgb")) return [parts[0], parts[1], parts[2]].map((n) => Math.max(0, Math.min(255, Math.round(n)))) as [number, number, number];
  const h = (((parts[0] % 360) + 360) % 360) / 360;
  const sat = Math.max(0, Math.min(1, parts[1] / 100));
  const l = Math.max(0, Math.min(1, parts[2] / 100));
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
  const p = 2 * l - q;
  const ch = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    const v = x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
    return Math.round(v * 255);
  };
  return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)];
}

/** Black or white, whichever reads on the given colour. */
export function contrastText(literal: string): "#000000" | "#ffffff" {
  const rgb = parseColor(literal);
  if (!rgb) return "#ffffff";
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#000000" : "#ffffff";
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
