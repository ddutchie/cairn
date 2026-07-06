import React, { useMemo, useRef } from "react";
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
  parseCalloutHeader,
  isColorLiteral,
  toggleCheckboxInSource,
} from "@cairn/shared/notes/markdown";

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

  // Checkbox render order counter — reset each render pass so tap → source index
  // stays aligned with the top-to-bottom order the parser emits.
  const checkboxCounter = useRef(0);
  checkboxCounter.current = 0;

  const rules = useMemo(
    () => makeRules(t, content ?? "", checkboxCounter, onChangeContent),
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
// ==highlight== support. Tables/strikethrough are on by default in markdown-it.
const markdownItInstance = MarkdownIt({ breaks: true, linkify: true, typographer: true }).use(
  markdownItMark,
);

const CHECKBOX_RE = /^\[([ xX])\]\s?/;

/** Custom render rules — code fences, callouts, highlight, checkboxes, swatches. */
function makeRules(
  t: Theme,
  source: string,
  checkboxCounter: React.MutableRefObject<number>,
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
    // Syntax-highlighted fenced / indented code blocks.
    fence: (node) => (
      <CodeBlock key={node.key} code={node.content} language={extractFenceLang(node)} />
    ),
    code_block: (node) => <CodeBlock key={node.key} code={node.content} />,

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

    // A blockquote whose first line is `[!type] Title` renders as a callout.
    blockquote: (node, children, _parent, styles) => {
      const firstText = extractFirstText(node);
      const meta = firstText ? parseCalloutHeader(firstText) : null;
      if (meta) {
        const accent = CALLOUT_ACCENT[meta.type] ?? t.accent;
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
              {meta.title || meta.type}
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

    // Task-list checkboxes: a list item whose text starts with `[ ]`/`[x]`.
    list_item: (node, children, parent, styles) => {
      const leading = extractFirstText(node);
      const cm = leading.match(CHECKBOX_RE);
      if (cm) {
        const checked = cm[1].toLowerCase() === "x";
        const index = checkboxCounter.current;
        checkboxCounter.current += 1;
        const interactive = !!onChangeContent;
        return (
          <View key={node.key} style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: 4 }}>
            <Pressable
              disabled={!interactive}
              hitSlop={8}
              onPress={() => onChangeContent?.(toggleCheckboxInSource(source, index))}
              style={{ paddingTop: 3, paddingRight: 8 }}
            >
              {checked ? (
                <CheckSquare size={16} color={t.accent} />
              ) : (
                <Square size={16} color={t.textTertiary} />
              )}
            </Pressable>
            <View style={{ flex: 1 }}>{children}</View>
          </View>
        );
      }
      // Fall back to the default bullet/ordered rendering.
      const ordered = parent[0]?.type === "ordered_list";
      return (
        <View key={node.key} style={{ flexDirection: "row", marginBottom: 4 }}>
          <Text style={ordered ? styles.ordered_list_icon : styles.bullet_list_icon}>
            {ordered ? `${(node.index ?? 0) + 1}.` : "•"}
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

/** Best-effort: pull the first text string out of a markdown-it node subtree. */
function extractFirstText(node: { children?: unknown[]; content?: string }): string {
  if (typeof node.content === "string" && node.content) return node.content;
  const kids = (node.children as { content?: string; children?: unknown[] }[] | undefined) ?? [];
  for (const k of kids) {
    const s = extractFirstText(k);
    if (s) return s;
  }
  return "";
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
    list_item: { color: t.textPrimary, marginBottom: 4 },
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
