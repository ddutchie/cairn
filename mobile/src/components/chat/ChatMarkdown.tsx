import { lazy, Suspense, useCallback, useMemo } from "react";
import { Linking, View } from "react-native";
import { useRouter } from "expo-router";
import { StreamdownText } from "react-native-streamdown";
import { useTheme, withAlpha, type Theme } from "@/theme";
import { findNoteIdByTitle, findCardIdByTitle, liveNoteTitleById, liveCardTitleById } from "@/db/queries";
import { preprocessCairnMarkdown, noteTitleFromUrl, cardIdFromUrl, type WikilinkResolver } from "@cairn/shared/notes/markdown";

// Mermaid ships its renderer as a ~1 MB inline string, so only load it when a diagram appears.
const MermaidView = lazy(() => import("@/components/MermaidView").then((m) => ({ default: m.MermaidView })));

/** An exact note/card id (what the assistant emits) first, then a title. Same order as `MarkdownView`. */
const resolveWikilink: WikilinkResolver = (ref) => {
  const noteTitle = liveNoteTitleById(ref);
  if (noteTitle) return { kind: "note", id: ref, title: noteTitle };
  const cardTitle = liveCardTitleById(ref);
  if (cardTitle) return { kind: "card", id: ref, title: cardTitle };
  const noteId = findNoteIdByTitle(ref);
  if (noteId) return { kind: "note", id: noteId };
  const cardId = findCardIdByTitle(ref);
  if (cardId) return { kind: "card", id: cardId };
  return null;
};

type Segment = { kind: "markdown"; text: string } | { kind: "mermaid"; code: string };

/**
 * Pull closed ```mermaid fences out of the text, since the native renderer can't draw them. An
 * unclosed fence stays in the markdown part, so a diagram only appears once it has fully streamed.
 */
export function splitMermaid(src: string): Segment[] {
  const out: Segment[] = [];
  const re = /^```mermaid[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push({ kind: "markdown", text: src.slice(last, m.index) });
    out.push({ kind: "mermaid", code: m[1] });
    last = m.index + m[0].length;
  }
  if (last < src.length || out.length === 0) out.push({ kind: "markdown", text: src.slice(last) });
  return out;
}

function markdownStyle(t: Theme, fontFamily: string | undefined, fontWeight: number | undefined, lineHeight: number | undefined) {
  const base = { color: t.textPrimary, fontSize: 15, fontFamily, fontWeight: fontWeight ? (String(fontWeight) as "400" | "500") : undefined };
  const line = Math.round(15 * 1.7 * (lineHeight ?? 1));
  const heading = { ...base, fontWeight: "700" as const, marginTop: 14, marginBottom: 6 };
  const mono = "Menlo";
  return {
    paragraph: { ...base, lineHeight: line, marginTop: 6, marginBottom: 6 },
    h1: { ...heading, fontSize: 24, lineHeight: Math.round(30 * (lineHeight ?? 1)) },
    h2: { ...heading, fontSize: 20, lineHeight: Math.round(26 * (lineHeight ?? 1)) },
    h3: { ...heading, fontSize: 17, lineHeight: Math.round(23 * (lineHeight ?? 1)) },
    h4: { ...heading, fontSize: 15 },
    h5: { ...heading, fontSize: 14, color: t.textSecondary },
    h6: { ...heading, fontSize: 13, color: t.textSecondary },
    strong: { fontWeight: "bold" as const, color: t.textPrimary },
    strikethrough: { color: t.textTertiary },
    link: { color: t.accent, underline: true },
    // Wikilinks arrive as cairn:// links: no underline, accent text on a faint wash.
    linkVariants: { "^cairn://": { color: t.accent, underline: false, backgroundColor: withAlpha(t.accent, 0.12) } },
    blockquote: { ...base, lineHeight: line, borderColor: t.border, borderWidth: 3, gapWidth: 12, backgroundColor: "transparent", marginTop: 10, marginBottom: 10 },
    code: { fontFamily: mono, fontSize: 13, color: t.textPrimary, backgroundColor: t.surface2, borderColor: t.border },
    codeBlock: { ...base, fontFamily: mono, fontSize: 13, lineHeight: 19, backgroundColor: t.surface2, borderColor: t.border, borderWidth: 1, borderRadius: 8, padding: 12, marginTop: 8, marginBottom: 12 },
    list: { ...base, lineHeight: line, bulletColor: t.accent, markerColor: t.textSecondary, gapWidth: 8, itemSpacing: 4, marginTop: 6, marginBottom: 6 },
    thematicBreak: { color: t.border, height: 1, marginTop: 16, marginBottom: 16 },
    table: {
      ...base, fontSize: 14, headerBackgroundColor: t.surface2, headerTextColor: t.textPrimary,
      rowEvenBackgroundColor: "transparent", rowOddBackgroundColor: "transparent",
      borderColor: t.border, borderWidth: 1, borderRadius: 6, cellPaddingHorizontal: 8, cellPaddingVertical: 8,
      marginTop: 10, marginBottom: 10,
    },
    taskList: { checkedColor: t.accent, borderColor: t.textTertiary, checkedStrikethrough: true, checkedTextColor: t.textTertiary },
    math: { color: t.textPrimary, backgroundColor: "transparent", fontSize: 18 },
    inlineMath: { color: t.textPrimary },
    highlight: { backgroundColor: withAlpha(t.accent, 0.25) },
  };
}

/**
 * Chat markdown on the native renderer: remend repairs the half-finished text off the JS thread
 * (react-native-streamdown), `preprocessCairnMarkdown` turns wikilinks into cairn:// links, and
 * closed mermaid fences are drawn by `MermaidView` between native segments.
 */
export function ChatMarkdown({ content, fontFamily, fontWeight, lineHeight }: { content: string; fontFamily?: string; fontWeight?: number; lineHeight?: number }) {
  const t = useTheme();
  const router = useRouter();
  const style = useMemo(() => markdownStyle(t, fontFamily, fontWeight, lineHeight), [t, fontFamily, fontWeight, lineHeight]);
  const src = useMemo(() => preprocessCairnMarkdown(content, resolveWikilink), [content]);
  const segments = useMemo(() => splitMermaid(src), [src]);

  const onLinkPress = useCallback(({ url }: { url: string }) => {
    const cardId = cardIdFromUrl(url);
    if (cardId != null) {
      const id = liveCardTitleById(cardId) != null ? cardId : findCardIdByTitle(cardId);
      if (id) router.push(`/card/${id}`);
      return;
    }
    const noteRef = noteTitleFromUrl(url);
    if (noteRef != null) {
      // A dead wikilink must not navigate.
      const id = findNoteIdByTitle(noteRef) ?? (liveNoteTitleById(noteRef) ? noteRef : null);
      if (id) router.push(`/note/${id}`);
      return;
    }
    Linking.openURL(url).catch(() => {});
  }, [router]);

  return (
    <View>
      {segments.map((s, i) =>
        s.kind === "mermaid" ? (
          <Suspense key={i} fallback={null}><MermaidView code={s.code} /></Suspense>
        ) : s.text.trim() ? (
          <StreamdownText
            key={i}
            markdown={s.text}
            flavor="github"
            md4cFlags={{ highlight: true }}
            markdownStyle={style}
            onLinkPress={onLinkPress}
          />
        ) : null,
      )}
    </View>
  );
}
