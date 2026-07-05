import React, { useMemo } from "react";
import Markdown from "react-native-markdown-display";
import { useTheme, type Theme } from "@/theme";

/**
 * Themed markdown renderer for note bodies. Wraps react-native-markdown-display
 * (pure JS) with a stylesheet derived from the shared Cairn theme tokens, so
 * rendered notes match the desktop's look. Supports GFM: headings, lists,
 * tables, code, blockquotes, links, task lists, hr, images.
 */
export function MarkdownView({ content }: { content: string }) {
  const t = useTheme();
  const styles = useMemo(() => markdownStyles(t), [t]);
  return <Markdown style={styles}>{content || ""}</Markdown>;
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
