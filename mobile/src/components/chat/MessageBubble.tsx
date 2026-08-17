import { memo, useMemo, useState } from "react";
import { View, Text, Image, StyleSheet, ActivityIndicator, Pressable } from "react-native";
import { Bot, User, Copy, Check } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { MarkdownView } from "@/components/MarkdownView";
import { useTheme, withAlpha, type as typeScale, type Theme } from "@/theme";
import { ReasoningBlock } from "./ReasoningBlock";
import { ToolTrail } from "./ToolTrail";
import type { UiMessage } from "@/chat/history";

/**
 * One chat message: avatar + column (tool trail, reasoning, bubble). Mirrors the
 * desktop `ChatMessageBubble`. Memoised so a stream-token update — which
 * replaces only the streaming assistant message object — re-renders just that
 * one bubble, not every prior message (each would otherwise re-run its
 * MarkdownView parse per token).
 */
export const MessageBubble = memo(function MessageBubble({ m }: { m: UiMessage }) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const isUser = m.role === "user";
  const [copied, setCopied] = useState(false);

  // Copy the message content — same behaviour as the desktop copy button.
  const handleCopy = async () => {
    try {
      await Clipboard.setStringAsync(m.content ?? "");
    } catch {
      /* clipboard unavailable — ignore */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Bubble corner radius from the theme's radius knob. sm/md keep the little
  // tail corner on the speaker side. "pill" is a generous chunky radius (20),
  // NOT a 999 value: a huge fixed radius on a wide chat bubble gets its corner
  // radii clamped to half the width, producing an elliptical "oval" end. 20 reads
  // as a pill on normal bubbles and can never oval. sm/md keep the tail; pill is
  // symmetric.
  const pill = t.chatRadius === "pill";
  const radius = pill ? 20 : t.chatRadius === "sm" ? 6 : 14;
  const tail = pill ? radius : 4;
  const shadow = t.chatShadow === "strong"
    ? { shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 6 }
    : t.chatShadow === "subtle"
      ? { shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.16, shadowRadius: 5, elevation: 3 }
      : null;

  // Bubble surface depends on the theme's bubble style: filled = solid
  // t.chatUser / t.chatAi, glass = translucent fill (blur handled natively on
  // iOS via the translucent colour), outlined = transparent fill + tinted border.
  const bubbleSurface = isUser
    ? t.chatBubbleStyle === "glass"
      ? styles.userBubbleGlass
      : t.chatBubbleStyle === "outlined"
        ? styles.userBubbleOutlined
        : styles.userBubble
    : t.chatBubbleStyle === "glass"
      ? styles.aiBubbleGlass
      : t.chatBubbleStyle === "outlined"
        ? styles.aiBubbleOutlined
        : styles.aiBubble;

  return (
    <View style={[styles.row, isUser && styles.rowUser]}>
      {/* Avatar */}
      <View style={[styles.avatar, isUser ? styles.avatarUser : styles.avatarBot]}>
        {isUser ? <User size={12} color={t.textTertiary} /> : <Bot size={12} color={t.accent} />}
      </View>

      {/* Column: tool chips, bubble, timestamp */}
      <View style={[styles.col, isUser && styles.colUser]}>
        {!isUser && m.tools && m.tools.length > 0 && <ToolTrail tools={m.tools} />}
        {!isUser && (m.reasoning || m.reasoningSummary) ? <ReasoningBlock text={m.reasoning ?? ""} summary={m.reasoningSummary} streaming={m.streaming} hasContent={!!m.content} /> : null}

        <View
          style={[
            styles.bubble,
            { borderRadius: radius, borderTopLeftRadius: isUser ? radius : tail, borderTopRightRadius: isUser ? tail : radius },
            bubbleSurface,
            shadow ?? null,
          ]}
        >
          {isUser && m.images && m.images.length > 0 && (
            <View style={styles.bubbleImages}>
              {m.images.map((uri, i) => (
                <Image key={i} source={{ uri }} style={styles.bubbleImg} />
              ))}
            </View>
          )}
          {m.role === "assistant" && m.streaming && !m.content ? (
            <ActivityIndicator color={t.textTertiary} size="small" />
          ) : isUser ? (
            m.content ? (
              <Text style={[styles.userText, {
                fontFamily: t.chatFont,
                fontWeight: t.chatFontWeight as 400 | 500,
                letterSpacing: t.chatTracking,
                lineHeight: Math.round(21 * t.chatLineHeight),
              }]}>
                {m.content}
              </Text>
            ) : null
          ) : (
            <MarkdownView
              content={m.content}
              resolveLinks
              useNoteFont={false}
              fontFamilyOverride={t.chatFont}
              fontWeightOverride={t.chatFontWeight}
              trackingOverride={t.chatTracking}
              lineHeightOverride={t.chatLineHeight}
            />
          )}
        </View>

        {!isUser && !m.streaming ? (
          <Pressable onPress={handleCopy} hitSlop={8} accessibilityLabel="Copy response" style={styles.copyBtn}>
            {copied ? <Check size={12} color={t.success} /> : <Copy size={12} color={t.textTertiary} />}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
});

function makeStyles(t: Theme) {
  return StyleSheet.create({
    // Row: avatar + column (reversed for user), matching the desktop bubble.
    row: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 14 },
    rowUser: { flexDirection: "row-reverse" },
    avatar: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", marginTop: 2, borderWidth: 1 },
    avatarBot: { backgroundColor: t.accentDim, borderColor: withAlpha(t.accent, 0.2) },
    avatarUser: { backgroundColor: t.surface3, borderColor: t.border },
    col: { flex: 1, minWidth: 0, gap: 6 },
    colUser: { alignItems: "flex-end" },

    bubble: { maxWidth: "94%", paddingHorizontal: 12, paddingVertical: 10 },
    aiBubble: { backgroundColor: t.chatAi, borderWidth: 1, borderColor: t.border, alignSelf: "flex-start" },
    userBubble: { backgroundColor: t.chatUser, alignSelf: "flex-end" },
    // Glass: translucent fill + a soft light border (iOS gives the native blur
    // via the translucent colour; Android renders the tinted fill).
    aiBubbleGlass: { backgroundColor: withAlpha(t.chatAi, 0.72), borderWidth: 1, borderColor: withAlpha("#ffffff", 0.22), alignSelf: "flex-start" },
    userBubbleGlass: { backgroundColor: withAlpha(t.chatUser, 0.78), alignSelf: "flex-end" },
    // Outlined: transparent fill + tinted border, text stays the theme token.
    aiBubbleOutlined: { backgroundColor: "transparent", borderWidth: 1, borderColor: withAlpha(t.chatAiText, 0.45), alignSelf: "flex-start" },
    userBubbleOutlined: { backgroundColor: withAlpha(t.chatUser, 0.18), borderWidth: 1, borderColor: withAlpha(t.chatUser, 0.6), alignSelf: "flex-end" },
    userText: { ...typeScale.body, color: t.chatUserFg },
    aiText: { ...typeScale.body, color: t.chatAiText },
    bubbleImages: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
    bubbleImg: { width: 120, height: 120, borderRadius: 8, backgroundColor: t.surface3 },
    copyBtn: { alignSelf: "flex-start", padding: 2, opacity: 0.6 },
  });
}
