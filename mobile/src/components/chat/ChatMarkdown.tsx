import { lazy, Suspense, useCallback, useMemo } from "react";
import { Linking, View } from "react-native";
import { useRouter } from "expo-router";
import { StreamdownText } from "react-native-streamdown";
import { useTheme, withAlpha, type Theme } from "@/theme";
import { findNoteIdByTitle, findCardIdByTitle, liveNoteTitleById, liveCardTitleById } from "@/db/queries";
import { preprocessCairnMarkdown, noteTitleFromUrl, cardIdFromUrl, type WikilinkResolver } from "@cairn/shared/notes/markdown";
import { SyncedImage } from "@/components/SyncedImage";
import {
  calloutsToAlerts, colorLiteralsToLinks, contrastText, escapeRegExp, escapeSpoilers, findColorLiterals,
  inlineEmbedsToText, markDeadWikilinks, splitSegments, COLOR_SCHEME,
} from "@/chat/native-markdown";

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

function markdownStyle(t: Theme, fontFamily: string | undefined, fontWeight: number | undefined, lineHeight: number | undefined, colors: readonly string[]) {
  const base = { color: t.textPrimary, fontSize: 15, fontFamily, fontWeight: fontWeight ? (String(fontWeight) as "400" | "500") : undefined };
  const line = Math.round(15 * 1.7 * (lineHeight ?? 1));
  const heading = { ...base, fontWeight: "700" as const, marginTop: 18, marginBottom: 10 };
  const mono = "Menlo";
  return {
    paragraph: { ...base, lineHeight: line, marginTop: 8, marginBottom: 8 },
    h1: { ...heading, fontSize: 24, lineHeight: Math.round(30 * (lineHeight ?? 1)) },
    h2: { ...heading, fontSize: 20, lineHeight: Math.round(26 * (lineHeight ?? 1)) },
    h3: { ...heading, fontSize: 17, lineHeight: Math.round(23 * (lineHeight ?? 1)) },
    h4: { ...heading, fontSize: 15 },
    h5: { ...heading, fontSize: 14, color: t.textSecondary },
    h6: { ...heading, fontSize: 13, color: t.textSecondary },
    strong: { fontWeight: "bold" as const, color: t.textPrimary },
    strikethrough: { color: t.textTertiary },
    link: { color: t.accent, underline: true },
    // Wikilinks arrive as cairn:// links: underlined accent text on a faint wash, as in the classic renderer.
    linkVariants: {
      "^cairn://": { color: t.accent, underline: true, backgroundColor: withAlpha(t.accent, 0.12) },
      // A wikilink that resolves to nothing: dimmed, and the tap is ignored.
      "^cairn://dead/": { color: t.textTertiary, underline: false, backgroundColor: "transparent" },
      // Colour literals: the colour as text on a neutral chip (white, or dark for light colours so they stay readable).
      ...Object.fromEntries(
        colors.map((c) => [`^${escapeRegExp(`${COLOR_SCHEME}${encodeURIComponent(c)}`)}$`, { color: c, underline: false, backgroundColor: contrastText(c) === "#000000" ? "#1f1f1f" : "#ffffff", fontFamily: mono }]),
      ),
    },
    blockquote: {
      ...base, lineHeight: line, borderColor: t.border, borderWidth: 3, gapWidth: 12, backgroundColor: "transparent", marginTop: 10, marginBottom: 10,
      admonitions: {
        note: { color: t.accent, backgroundColor: withAlpha(t.accent, 0.08) },
        tip: { color: t.success, backgroundColor: withAlpha(t.success, 0.08) },
        important: { color: t.accent, backgroundColor: withAlpha(t.accent, 0.08) },
        warning: { color: t.warning, backgroundColor: withAlpha(t.warning, 0.08) },
        caution: { color: t.danger, backgroundColor: withAlpha(t.danger, 0.08) },
      },
    },
    code: { fontFamily: mono, fontSize: 13, color: t.textPrimary, backgroundColor: t.surface2, borderColor: t.border },
    codeBlock: { ...base, fontFamily: mono, fontSize: 13, lineHeight: 19, backgroundColor: t.surface2, borderColor: t.border, borderWidth: 1, borderRadius: 8, padding: 12, marginTop: 8, marginBottom: 12 },
    list: { ...base, lineHeight: line, bulletColor: t.accent, bulletSize: 4, markerColor: t.textSecondary, gapWidth: 13, itemSpacing: 6, marginTop: 8, marginBottom: 8 },
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
 * the pieces it cannot draw (mermaid, synced images) are rendered by their own components between native segments.
 */
export function ChatMarkdown({ content, fontFamily, fontWeight, lineHeight }: { content: string; fontFamily?: string; fontWeight?: number; lineHeight?: number }) {
  const t = useTheme();
  const router = useRouter();
  // Everything the native renderer can't take as-is is rewritten here, in one pass per content change.
  const { segments, colors } = useMemo(() => {
    const dead = new Set<string>();
    const resolve: WikilinkResolver = (ref) => {
      const hit = resolveWikilink(ref);
      if (!hit) dead.add(ref);
      return hit;
    };
    let src = preprocessCairnMarkdown(calloutsToAlerts(content), resolve, { imageEmbeds: true });
    src = markDeadWikilinks(colorLiteralsToLinks(escapeSpoilers(src)), dead);
    return { segments: splitSegments(src), colors: findColorLiterals(content) };
  }, [content]);
  const colorsKey = colors.join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `colors` is a fresh array per content change; its joined key is the real dependency
  const style = useMemo(() => markdownStyle(t, fontFamily, fontWeight, lineHeight, colors), [t, fontFamily, fontWeight, lineHeight, colorsKey]);

  const onLinkPress = useCallback(({ url }: { url: string }) => {
    if (url.startsWith("cairn://dead/") || url.startsWith(COLOR_SCHEME)) return;
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
        ) : s.kind === "image" ? (
          <SyncedImage key={i} name={s.name} />
        ) : (
          <StreamdownText
            key={i}
            markdown={inlineEmbedsToText(s.text)}
            flavor="github"
            md4cFlags={{ highlight: true }}
            markdownStyle={style}
            onLinkPress={onLinkPress}
          />
        ),
      )}
    </View>
  );
}
