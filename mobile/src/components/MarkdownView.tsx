import React, { useMemo } from "react";
import { Linking, Text, View } from "react-native";
import Markdown, { type RenderRules } from "react-native-markdown-display";
import { useRouter } from "expo-router";
import { useTheme, withAlpha, type Theme } from "@/theme";
import { findNoteIdByTitle } from "@/db/queries";
import { preprocessCairnMarkdown, noteTitleFromUrl, parseCalloutHeader } from "@cairn/shared/notes/markdown";

/**
 * Themed markdown renderer with Cairn parity: GFM (headings, lists, tables,
 * code, quotes) PLUS the desktop's Cairn syntax:
 *   - [[Wikilinks]] → tappable, navigate to the linked note (unresolved =
 *     dimmed, non-navigating).
 *   - ![[embeds]] → italic placeholder (binary assets out of the mobile MVP).
 *   - > [!type] callouts → styled callout blocks.
 *
 * Cairn syntax is rewritten to standard markdown (shared preprocessCairnMarkdown)
 * so markdown-it can parse it; wikilinks become cairn://note/ links intercepted
 * by onLinkPress.
 */
export function MarkdownView({ content }: { content: string }) {
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

  const rules = useMemo(() => makeRules(t), [t]);

  return (
    <Markdown style={styles} rules={rules} onLinkPress={onLinkPress}>
      {src}
    </Markdown>
  );
}

/** Custom render rules — callout blockquotes + wikilink chip styling. */
function makeRules(t: Theme): RenderRules {
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
    // A blockquote whose first line is `[!type] Title` renders as a callout.
    blockquote: (node, children, _parent, styles) => {
      // Extract the leading text of the first child to detect a callout header.
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
            <Text style={{ color: accent, fontWeight: "700", fontSize: 13, textTransform: "capitalize", marginBottom: 4 }}>
              {meta.title || meta.type}
            </Text>
            {children}
          </View>
        );
      }
      // Plain blockquote.
      return (
        <View key={node.key} style={styles.blockquote}>
          {children}
        </View>
      );
    },
  };
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

function markdownStyles(t: Theme) {
  const mono = "Menlo";
  return {
    body: { color: t.textPrimary, fontSize: 16, lineHeight: 24 },
    heading1: { color: t.textPrimary, fontSize: 26, fontWeight: "700" as const, marginTop: 18, marginBottom: 8, lineHeight: 32 },
    heading2: { color: t.textPrimary, fontSize: 22, fontWeight: "700" as const, marginTop: 16, marginBottom: 6, lineHeight: 28 },
    heading3: { color: t.textPrimary, fontSize: 18, fontWeight: "600" as const, marginTop: 14, marginBottom: 4 },
    heading4: { color: t.textPrimary, fontSize: 16, fontWeight: "600" as const, marginTop: 12, marginBottom: 4 },
    heading5: { color: t.textSecondary, fontSize: 15, fontWeight: "600" as const, marginTop: 10 },
    heading6: { color: t.textSecondary, fontSize: 14, fontWeight: "600" as const, marginTop: 10 },
    paragraph: { color: t.textPrimary, marginTop: 0, marginBottom: 12, lineHeight: 24 },
    strong: { fontWeight: "700" as const, color: t.textPrimary },
    em: { fontStyle: "italic" as const },
    s: { textDecorationLine: "line-through" as const, color: t.textTertiary },
    link: { color: t.accent, textDecorationLine: "underline" as const },
    blockquote: {
      backgroundColor: t.surface2,
      borderLeftColor: t.accent,
      borderLeftWidth: 3,
      paddingHorizontal: 12,
      paddingVertical: 4,
      marginBottom: 12,
      borderRadius: 4,
    },
    code_inline: {
      color: t.accent,
      backgroundColor: t.surface2,
      fontFamily: mono,
      fontSize: 14,
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: 4,
    },
    code_block: {
      color: t.textPrimary,
      backgroundColor: t.surface2,
      fontFamily: mono,
      fontSize: 13,
      padding: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: t.border,
      marginBottom: 12,
    },
    fence: {
      color: t.textPrimary,
      backgroundColor: t.surface2,
      fontFamily: mono,
      fontSize: 13,
      padding: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: t.border,
      marginBottom: 12,
    },
    bullet_list: { marginBottom: 12 },
    ordered_list: { marginBottom: 12 },
    list_item: { color: t.textPrimary, marginBottom: 4 },
    bullet_list_icon: { color: t.accent },
    ordered_list_icon: { color: t.textSecondary },
    hr: { backgroundColor: t.border, height: 1, marginVertical: 16 },
    table: { borderColor: t.border, borderWidth: 1, borderRadius: 8, marginBottom: 12 },
    thead: { backgroundColor: t.surface2 },
    th: { color: t.textPrimary, padding: 8, fontWeight: "600" as const },
    tr: { borderBottomColor: t.border, borderBottomWidth: 1 },
    td: { color: t.textPrimary, padding: 8 },
    image: { borderRadius: 8, marginVertical: 8 },
  };
}
