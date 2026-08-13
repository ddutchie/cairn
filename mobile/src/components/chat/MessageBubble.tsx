import { memo, useMemo } from "react";
import { View, Text, Image, StyleSheet, ActivityIndicator } from "react-native";
import { Bot, User } from "lucide-react-native";
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
  return (
    <View style={[styles.row, isUser && styles.rowUser]}>
      {/* Avatar */}
      <View style={[styles.avatar, isUser ? styles.avatarUser : styles.avatarBot]}>
        {isUser ? <User size={12} color={t.textTertiary} /> : <Bot size={12} color={t.accent} />}
      </View>

      {/* Column: tool chips, bubble, timestamp */}
      <View style={[styles.col, isUser && styles.colUser]}>
        {!isUser && m.reasoning ? <ReasoningBlock text={m.reasoning} summary={m.reasoningSummary} streaming={m.streaming} /> : null}
        {!isUser && m.tools && m.tools.length > 0 && <ToolTrail tools={m.tools} />}

        <View style={[styles.bubble, isUser ? styles.userBubble : styles.aiBubble]}>
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
            m.content ? <Text style={styles.userText}>{m.content}</Text> : null
          ) : (
            <MarkdownView content={m.content} resolveLinks />
          )}
        </View>
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

    bubble: { maxWidth: "94%", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14 },
    aiBubble: { backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderTopLeftRadius: 4, alignSelf: "flex-start" },
    userBubble: { backgroundColor: t.accent, borderTopRightRadius: 4, alignSelf: "flex-end" },
    userText: { ...typeScale.body, lineHeight: 21, color: t.accentFg },
    bubbleImages: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
    bubbleImg: { width: 120, height: 120, borderRadius: 8, backgroundColor: t.surface3 },
  });
}
