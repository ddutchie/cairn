import { lazy, Suspense, useMemo } from "react";
import { Linking, Text, View, Pressable } from "react-native";
import Markdown, { MarkdownIt, type RenderRules, type ASTNode } from "react-native-markdown-display";
import markdownItMark from "markdown-it-mark";
import { useRouter } from "expo-router";
import { Square, CheckSquare } from "lucide-react-native";
import { useTheme, withAlpha, type Theme } from "@/theme";
import { findNoteIdByTitle } from "@/db/queries";
import { CodeBlock } from "@/components/CodeBlock";
import {
  preprocessCairnMarkdown,
  noteTitleFromUrl,
  isColorLiteral,
  toggleCheckboxInSource,
} from "@cairn/shared/notes/markdown";

// Mermaid + KaTeX bundle their renderer sources as ~1 MB inline strings
// (mermaid-assets.ts alone is 3.5k lines). A static import would evaluate those
// modules — and heap-allocate the strings — at bundle init, i.e. every time ANY
// note opens, even a plain-text one. Loading them lazily defers that cost until
// a note actually contains a diagram / math block.
const MermaidView = lazy(() =>
  import("@/components/MermaidView").then((m) => ({ default: m.MermaidView })),
);
const MathView = lazy(() =>
  import("@/components/MathView").then((m) => ({ default: m.MathView })),
);

/**
 * Themed markdown renderer with Cairn desktop parity.
 *
 * Features mirrored from the desktop remark pipeline / .prose-cairn styling:
 *   - GFM: headings, lists, tables, blockquotes, strikethrough.
 *   - Syntax-highlighted fenced code (CodeBlock) with a language header + copy.
 *   - [[Wikilinks]] → tappable, navigate to the linked note.
 *   - ![[embeds]] → italic placeholder (binary assets out of the mobile MVP).
 *   - > [!type] callouts → coloured callout blocks.
 *   - ==highlight== → <mark> (via markdown-it-mark).
 *   - Interactive task-list checkboxes — tapping toggles the source and calls
 *     onChangeContent (when provided).
 *   - Inline code colour swatches for CSS colour literals.
 *
 * Cairn syntax is rewritten to standard markdown (shared preprocessCairnMarkdown)
 * so markdown-it can parse it; wikilinks become cairn://note/ links intercepted
 * by onLinkPress.
 */
export function MarkdownView({
  content,
  onChangeContent,
}: {
  content: string;
  /** When provided, task-list checkboxes become interactive. */
  onChangeContent?: (next: string) => void;
}) {
  const t = useTheme();
  const router = useRouter();
  const styles = useMemo(() => markdownStyles(t), [t]);
  const src = useMemo(() => preprocessCairnMarkdown(content ?? ""), [content]);

  const onLinkPress = (url: string): boolean => {
    const title = noteTitleFromUrl(url);
    if (title != null) {
      const id = findNoteIdByTitle(title);
      if (id) router.push(`/note/${id}`);
      return false; // handled (whether resolved or not) — don't open externally
    }
    Linking.openURL(url).catch(() => {});
    return false;
  };
  const rules = useMemo(
    () => makeRules(t, content ?? "", onChangeContent),
    [t, content, onChangeContent],
  );

  return (
    <Markdown
      markdownit={markdownItInstance}
      style={styles}
      rules={rules}
      onLinkPress={onLinkPress}
    >
      {src}
    </Markdown>
  );
}

// A single markdown-it instance: GFM-ish (breaks + linkify + typographer) plus
// ==highlight== support and task-list detection. Tables/strikethrough are on by
// default in markdown-it.
const markdownItInstance = MarkdownIt({ breaks: true, linkify: true, typographer: true })
  .use(markdownItMark)
  .use(taskListPlugin as unknown as Parameters<ReturnType<typeof MarkdownIt>["use"]>[0])
  .use(calloutPlugin as unknown as Parameters<ReturnType<typeof MarkdownIt>["use"]>[0])
  .use(mathPlugin as unknown as Parameters<ReturnType<typeof MarkdownIt>["use"]>[0]);

/**
 * markdown-it plugin: detect GFM task-list items. For each list item whose first
 * inline text starts with `[ ]`/`[x]`, strip that marker from the text token and
 * stash `{ isTask, checked, taskIndex }` on the `list_item_open` token's meta.
 * Stripping here (not in the render rule) is what stops the literal `[x]` from
 * rendering twice — the marker is gone from the children by render time.
 */
function taskListPlugin(md: MdItLike) {
  md.core.ruler.after("inline", "cairn_task_lists", (state) => {
    const tokens = state.tokens as MdToken[];
    let taskIndex = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "list_item_open") continue;
      // Find the inline token inside this list item (list_item_open →
      // paragraph_open → inline).
      const inline = tokens[i + 2];
      if (!inline || inline.type !== "inline" || !inline.children?.length) continue;
      const firstText = inline.children.find((c) => c.type === "text");
      if (!firstText) continue;
      const m = /^\[([ xX])\]\s?/.exec(firstText.content);
      if (!m) continue;
      firstText.content = firstText.content.slice(m[0].length);
      tokens[i].meta = {
        ...(tokens[i].meta as object),
        isTask: true,
        checked: m[1].toLowerCase() === "x",
        taskIndex,
      };
      taskIndex += 1;
    }
    return true;
  });
}

/**
 * markdown-it plugin: strip the `[!type] Title` header line from callout
 * blockquotes so it isn't rendered twice (the render rule draws its own title).
 * The header lives as the first text child of the blockquote's inline token,
 * followed by a softbreak — we clear both and stash the parsed meta on the
 * blockquote_open token.
 */
function calloutPlugin(md: MdItLike) {
  md.core.ruler.after("inline", "cairn_callouts", (state) => {
    const tokens = state.tokens as MdToken[];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "blockquote_open") continue;
      // blockquote_open → paragraph_open → inline
      const inline = tokens[i + 2];
      if (!inline || inline.type !== "inline" || !inline.children?.length) continue;
      const kids = inline.children;
      const first = kids[0];
      if (!first || first.type !== "text") continue;
      const m = /^\[!([^\]]+)\]\s*(.*)$/.exec(first.content);
      if (!m) continue;
      // Drop the header text token; also drop a leading softbreak so the body
      // starts on the next line without a blank first row.
      kids.shift();
      if (kids[0] && kids[0].type === "softbreak") kids.shift();
      inline.content = kids.map((k) => k.content).join("");
      tokens[i].meta = {
        ...(tokens[i].meta as object),
        callout: { type: m[1].trim().toLowerCase(), title: m[2].trim() || undefined },
      };
    }
    return true;
  });
}

// Minimal structural types for the markdown-it plugin (no @types/markdown-it).
interface MdToken {
  type: string;
  content: string;
  meta?: unknown;
  children?: MdToken[] | null;
}
interface MdItLike {
  core: {
    ruler: {
      after: (after: string, name: string, fn: (state: { tokens: unknown[] }) => boolean) => void;
    };
  };
}

/**
 * markdown-it plugin: KaTeX-style math. Adds a block rule for `$$…$$` (emits a
 * `math_block` token) and an inline rule for `$…$` (emits `math_inline`). The
 * LaTeX source lands in token.content; render rules hand it to MathView.
 *
 * Typed loosely against markdown-it's runtime shapes (no @types/markdown-it);
 * the logic mirrors the common markdown-it-texmath dollar rules.
 */
 
function mathPlugin(md: any) {
  // Inline: $...$  (no space right after the opening $, not a lone $)
  md.inline.ruler.after("escape", "math_inline", (state: any, silent: boolean) => {
    const start = state.pos;
    if (state.src[start] !== "$") return false;
    // Escaped \$ handled by the escape rule already.
    const next = state.src[start + 1];
    if (next === undefined || next === " " || next === "$") return false;
    let end = start + 1;
    while (end < state.posMax) {
      if (state.src[end] === "$" && state.src[end - 1] !== "\\" && state.src[end - 1] !== " ") break;
      end += 1;
    }
    if (end >= state.posMax || state.src[end] !== "$") return false;
    const content = state.src.slice(start + 1, end);
    if (!content.trim()) return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = content;
      token.markup = "$";
    }
    state.pos = end + 1;
    return true;
  });

  // Block: a line that is exactly $$ ... $$ (single or multi-line).
  md.block.ruler.before(
    "fence",
    "math_block",
    (state: any, startLine: number, endLine: number, silent: boolean) => {
      const startPos = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      if (startPos + 2 > max) return false;
      if (state.src.slice(startPos, startPos + 2) !== "$$") return false;
      // Find the closing $$.
      let nextLine = startLine;
      let haveEnd = false;
      let firstLine = state.src.slice(startPos + 2, max);
      if (firstLine.trim().endsWith("$$")) {
        firstLine = firstLine.trim().replace(/\$\$$/, "");
        haveEnd = true;
      }
      const buf: string[] = firstLine ? [firstLine] : [];
      while (!haveEnd) {
        nextLine += 1;
        if (nextLine >= endLine) break;
        const from = state.bMarks[nextLine] + state.tShift[nextLine];
        const to = state.eMarks[nextLine];
        const line = state.src.slice(from, to);
        if (line.trim().endsWith("$$")) {
          buf.push(line.trim().replace(/\$\$$/, ""));
          haveEnd = true;
        } else {
          buf.push(line);
        }
      }
      if (!haveEnd) return false;
      if (silent) return true;
      state.line = nextLine + 1;
      const token = state.push("math_block", "math", 0);
      token.block = true;
      token.content = buf.join("\n").trim();
      token.markup = "$$";
      return true;
    },
  );
}
 


/** Custom render rules — code fences, callouts, highlight, checkboxes, swatches. */
function makeRules(
  t: Theme,
  source: string,
  onChangeContent?: (next: string) => void,
): RenderRules {
  const CALLOUT_ACCENT: Record<string, string> = {
    note: t.accent,
    info: t.info,
    tip: t.success,
    success: t.success,
    warning: t.warning,
    danger: t.danger,
    error: t.danger,
    question: t.info,
    quote: t.textTertiary,
  };

  return {
    // Syntax-highlighted fenced / indented code blocks; mermaid → diagram.
    fence: (node) => {
      const lang = extractFenceLang(node);
      if (lang === "mermaid")
        return (
          <Suspense key={node.key} fallback={<View style={{ height: 60 }} />}>
            <MermaidView code={node.content} />
          </Suspense>
        );
      return <CodeBlock key={node.key} code={node.content} language={lang} />;
    },
    code_block: (node) => <CodeBlock key={node.key} code={node.content} />,

    // KaTeX math (from mathPlugin).
    math_inline: (node) => (
      <Suspense key={node.key} fallback={<Text> </Text>}>
        <MathView latex={node.content} display={false} />
      </Suspense>
    ),
    math_block: (node) => (
      <Suspense key={node.key} fallback={<View style={{ height: 40 }} />}>
        <MathView latex={node.content} display={true} />
      </Suspense>
    ),

    // ==highlight== → mark chip.
    mark: (node, children) => (
      <Text
        key={node.key}
        style={{
          backgroundColor: withAlpha(t.warning, 0.28),
          color: t.textPrimary,
        }}
      >
        {children}
      </Text>
    ),

    // A blockquote tagged by calloutPlugin renders as a coloured callout; the
    // `[!type] Title` header line has already been stripped from the children.
    blockquote: (node, children, _parent, styles) => {
      const meta = (node as { sourceMeta?: { callout?: { type: string; title?: string } } }).sourceMeta;
      const callout = meta?.callout;
      if (callout) {
        const accent = CALLOUT_ACCENT[callout.type] ?? t.accent;
        return (
          <View
            key={node.key}
            style={{
              backgroundColor: withAlpha(accent, 0.1),
              borderLeftColor: accent,
              borderLeftWidth: 3,
              borderRadius: 6,
              paddingHorizontal: 12,
              paddingVertical: 8,
              marginBottom: 12,
            }}
          >
            <Text
              style={{
                color: accent,
                fontWeight: "700",
                fontSize: 13,
                textTransform: "capitalize",
                marginBottom: 4,
              }}
            >
              {callout.title || callout.type}
            </Text>
            {children}
          </View>
        );
      }
      return (
        <View key={node.key} style={styles.blockquote}>
          {children}
        </View>
      );
    },

    // Task-list checkboxes (tagged by taskListPlugin) render an icon in place of
    // the bullet; plain list items keep the default bullet/number.
    list_item: (node, children, parent, _styles) => {
      const meta = (node as { sourceMeta?: { isTask?: boolean; checked?: boolean; taskIndex?: number } })
        .sourceMeta;
      if (meta?.isTask) {
        const checked = !!meta.checked;
        const index = meta.taskIndex ?? 0;
        const interactive = !!onChangeContent;
        return (
          <View key={node.key} style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: 4 }}>
            <Pressable
              disabled={!interactive}
              hitSlop={8}
              onPress={() => onChangeContent?.(toggleCheckboxInSource(source, index))}
              style={{ paddingTop: 2, paddingRight: 8 }}
            >
              {checked ? (
                <CheckSquare size={17} color={t.accent} />
              ) : (
                <Square size={17} color={t.textTertiary} />
              )}
            </Pressable>
            <View style={{ flex: 1 }}>{children}</View>
          </View>
        );
      }

      // Plain list item — mirror the library's default bullet / ordered marker
      // so non-task lists look identical to before. Inline the marker style with
      // a fixed width so the dot always shows regardless of style merging.
      const ordered = hasParentType(parent, "ordered_list");
      return (
        <View key={node.key} style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: 4 }}>
          <Text
            accessible={false}
            style={{
              color: ordered ? t.textSecondary : t.accent,
              width: ordered ? 22 : 16,
              lineHeight: 15 * 1.7,
              fontWeight: "700",
            }}
          >
            {ordered ? `${(node.index ?? 0) + 1}.` : "\u2022"}
          </Text>
          <View style={{ flex: 1 }}>{children}</View>
        </View>
      );
    },

    // Inline code — render a colour swatch before CSS colour literals.
    code_inline: (node, _children, _parent, styles) => {
      const text = node.content ?? "";
      const swatch = isColorLiteral(text) ? text.trim() : null;
      return (
        <Text key={node.key} style={styles.code_inline}>
          {swatch ? (
            <Text>
              <Text style={{ color: swatch }}>{"\u25A0 "}</Text>
              {text}
            </Text>
          ) : (
            text
          )}
        </Text>
      );
    },
  };
}

/** Pull the fenced-code language from the token's info string. */
function extractFenceLang(node: ASTNode): string | undefined {
  const info = (node as { sourceInfo?: string }).sourceInfo;
  if (!info) return undefined;
  return info.trim().split(/\s+/)[0] || undefined;
}

/** True if any ancestor node is a list of the given type. */
function hasParentType(parents: ASTNode[], type: string): boolean {
  return parents.some((p) => p.type === type);
}

// ── Styles ── tuned to match the desktop .prose-cairn spec (globals.css:357).
// Desktop base is 0.875rem @ line-height 1.7; headings h1 1.5rem/700,
// h2 1.2rem/600, h3 1rem/600; tight paragraph/list margins.
function markdownStyles(t: Theme) {
  const mono = "Menlo";
  const BASE = 15;
  const LINE = BASE * 1.7;
  return {
    body: { color: t.textPrimary, fontSize: BASE, lineHeight: LINE },
    heading1: { color: t.textPrimary, fontSize: 24, fontWeight: "700" as const, marginTop: 20, marginBottom: 8, lineHeight: 30 },
    heading2: { color: t.textPrimary, fontSize: 20, fontWeight: "600" as const, marginTop: 16, marginBottom: 6, lineHeight: 26 },
    heading3: { color: t.textPrimary, fontSize: 17, fontWeight: "600" as const, marginTop: 12, marginBottom: 4, lineHeight: 23 },
    heading4: { color: t.textPrimary, fontSize: 15, fontWeight: "600" as const, marginTop: 10, marginBottom: 4 },
    heading5: { color: t.textSecondary, fontSize: 14, fontWeight: "600" as const, marginTop: 8 },
    heading6: { color: t.textSecondary, fontSize: 13, fontWeight: "600" as const, marginTop: 8 },
    paragraph: { color: t.textPrimary, marginTop: 8, marginBottom: 8, lineHeight: LINE },
    strong: { fontWeight: "600" as const, color: t.textPrimary },
    em: { fontStyle: "italic" as const },
    s: { textDecorationLine: "line-through" as const, color: t.textTertiary },
    link: { color: t.accent, textDecorationLine: "underline" as const },
    blockquote: {
      borderLeftColor: t.accent,
      borderLeftWidth: 3,
      paddingHorizontal: 14,
      paddingVertical: 4,
      marginVertical: 12,
      // desktop: text-secondary, no fill
    },
    code_inline: {
      color: t.textPrimary,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      fontFamily: mono,
      fontSize: 13,
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: 3,
    },
    // fence / code_block are handled by the CodeBlock rule; keep minimal styles
    // as a fallback in case a rule is bypassed.
    code_block: { color: t.textPrimary, backgroundColor: t.surface2, fontFamily: mono, fontSize: 13, padding: 12, borderRadius: 8, marginBottom: 12 },
    fence: { color: t.textPrimary, backgroundColor: t.surface2, fontFamily: mono, fontSize: 13, padding: 12, borderRadius: 8, marginBottom: 12 },
    bullet_list: { marginVertical: 8 },
    ordered_list: { marginVertical: 8 },
    // Row layout comes from the library default; we add spacing + alignment.
    list_item: { flexDirection: "row" as const, justifyContent: "flex-start" as const, alignItems: "flex-start" as const, marginBottom: 4 },
    bullet_list_content: { flex: 1 },
    ordered_list_content: { flex: 1 },
    bullet_list_icon: { color: t.accent, marginRight: 8, lineHeight: LINE },
    ordered_list_icon: { color: t.textSecondary, marginRight: 8, lineHeight: LINE },
    hr: { backgroundColor: t.border, height: 1, marginVertical: 16 },
    table: { borderColor: t.border, borderWidth: 1, borderRadius: 6, marginVertical: 12 },
    thead: { backgroundColor: t.surface2 },
    th: { color: t.textPrimary, padding: 8, fontWeight: "600" as const },
    tr: { borderBottomColor: t.border, borderBottomWidth: 1 },
    td: { color: t.textPrimary, padding: 8 },
    image: { borderRadius: 8, marginVertical: 8 },
  };
}
