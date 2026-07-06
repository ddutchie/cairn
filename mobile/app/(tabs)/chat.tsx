import { useCallback, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Image,
  Alert,
} from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useKeyboardHandler } from "react-native-keyboard-controller";
import { CheckCircle, Bot, User, Send, ImagePlus, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "@/components/Screen";
import { GlassBar, glassActive } from "@/components/GlassBar";
import { MarkdownView } from "@/components/MarkdownView";
import { useTheme, withAlpha, type Theme } from "@/theme";
import { runAgent, userMessage, type AgentEvent, type Attachment } from "@/chat/agent";
import { pickImages, takePhoto } from "@/chat/attachments";
import { prettifyToolLabel } from "@cairn/shared/ui/constants";
import type { UIMessage } from "@/chat/rork-client";

interface UiMessage {
  role: "user" | "assistant";
  content: string;
  images?: string[]; // data URIs for user attachments
  tools?: { tool: string; ok: boolean }[];
  streaming?: boolean;
}

/**
 * Track the keyboard height as a shared value that animates in lockstep with
 * the system keyboard (react-native-keyboard-controller). Driving a spacer
 * View off this gives frame-perfect avoidance with no dead space — unlike
 * KeyboardAvoidingView (see Expo keyboard docs).
 */
function useGradualAnimation() {
  const height = useSharedValue(0);
  useKeyboardHandler(
    {
      onMove: (e) => {
        "worklet";
        height.value = e.height;
      },
    },
    [],
  );
  return { height };
}

export default function ChatScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  // Persistent agent conversation (UIMessage parts format) across turns.
  const conversation = useRef<UIMessage[]>([]);

  const { height: kbHeight } = useGradualAnimation();
  // Spacer below the composer: keyboard height when open, else the bottom safe
  // area + a little breathing room (so the composer clears the tab bar and
  // doesn't feel cramped). max() avoids double-spacing.
  const spacer = useAnimatedStyle(() => ({
    height: Math.max(kbHeight.value, insets.bottom + 6),
  }), [insets.bottom]);

  const send = useCallback(async () => {
    const text = input.trim();
    const atts = attachments;
    if ((!text && atts.length === 0) || busy) return;
    setInput("");
    setAttachments([]);
    setBusy(true);

    // UI: add the user bubble + an empty streaming assistant bubble.
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text, images: atts.map((a) => a.url) },
      { role: "assistant", content: "", tools: [], streaming: true },
    ]);

    conversation.current.push(userMessage(text, atts));
    let acc = "";
    const toolTrail: { tool: string; ok: boolean }[] = [];

    const patchAssistant = (patch: Partial<UiMessage>) => {
      setMessages((prev) => {
        const copy = [...prev];
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].role === "assistant" && copy[i].streaming) {
            copy[i] = { ...copy[i], ...patch };
            break;
          }
        }
        return copy;
      });
    };

    try {
      const onEvent = (e: AgentEvent) => {
        if (e.type === "text-delta" && e.delta) {
          acc += e.delta;
          patchAssistant({ content: acc });
        } else if (e.type === "tool" && e.tool) {
          const ok = !(e.result && typeof e.result === "object" && "error" in (e.result as object));
          toolTrail.push({ tool: e.tool, ok });
          patchAssistant({ tools: [...toolTrail] });
        }
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 20);
      };
      const answer = await runAgent(conversation.current, onEvent);
      patchAssistant({ content: answer || acc, streaming: false, tools: toolTrail.length ? toolTrail : undefined });
    } catch (e) {
      const msg = e instanceof Error && /network|fetch|failed/i.test(e.message)
        ? "Chat needs a connection. Reconnect and try again."
        : `Error: ${e instanceof Error ? e.message : String(e)}`;
      patchAssistant({ content: msg, streaming: false });
    } finally {
      setBusy(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [input, attachments, busy]);

  const addImages = useCallback(async () => {
    try {
      const picked = await pickImages();
      if (picked.length === 0) return;
      setAttachments((prev) => [...prev, ...picked].slice(0, 4));
    } catch (e) {
      Alert.alert("Couldn't add image", e instanceof Error ? e.message : String(e));
    }
  }, []);

  const capturePhoto = useCallback(async () => {
    try {
      const shot = await takePhoto();
      if (shot.length === 0) return;
      setAttachments((prev) => [...prev, ...shot].slice(0, 4));
    } catch (e) {
      Alert.alert("Couldn't take photo", e instanceof Error ? e.message : String(e));
    }
  }, []);

  const onAttach = useCallback(() => {
    Alert.alert("Add image", undefined, [
      { text: "Photo Library", onPress: addImages },
      { text: "Take Photo", onPress: capturePhoto },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [addImages, capturePhoto]);

  const removeAttachment = (idx: number) => setAttachments((prev) => prev.filter((_, i) => i !== idx));

  return (
    <Screen title="Chat">
      <View style={{ flex: 1 }}>
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {messages.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Ask Cairn</Text>
              <Text style={styles.emptyHint}>
                Ask about your notes, or tell the assistant to create or edit them. Changes sync to your
                desktop.
              </Text>
            </View>
          ) : (
            messages.map((m, i) => <Bubble key={i} m={m} t={t} styles={styles} />)
          )}
        </ScrollView>

        {attachments.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.previewStrip} contentContainerStyle={styles.previewContent}>
            {attachments.map((a, i) => (
              <View key={i} style={styles.previewItem}>
                <Image source={{ uri: a.url }} style={styles.previewImg} />
                <Pressable style={styles.previewRemove} onPress={() => removeAttachment(i)} hitSlop={6}>
                  <X size={12} color="#fff" />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}

        <View style={styles.composer}>
          <Pressable style={styles.attachBtn} onPress={onAttach} disabled={busy} hitSlop={6}>
            <ImagePlus size={22} color={busy ? t.textTertiary : t.accent} />
          </Pressable>
          <GlassBar style={styles.inputGlass}>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder="Message Cairn…"
              placeholderTextColor={t.textTertiary}
              multiline
              editable={!busy}
            />
          </GlassBar>
          <Pressable
            style={[styles.sendBtn, ((!input.trim() && attachments.length === 0) || busy) && styles.sendBtnDisabled]}
            onPress={send}
            disabled={(!input.trim() && attachments.length === 0) || busy}
          >
            {busy ? <ActivityIndicator color={t.accentFg} size="small" /> : <Send size={18} color={t.accentFg} />}
          </Pressable>
        </View>

        {/* Animated spacer: tracks the keyboard, else the bottom safe area. */}
        <Animated.View style={spacer} />
      </View>
    </Screen>
  );
}

function Bubble({ m, t, styles }: { m: UiMessage; t: Theme; styles: ReturnType<typeof makeStyles> }) {
  const isUser = m.role === "user";
  return (
    <View style={[styles.row, isUser && styles.rowUser]}>
      {/* Avatar */}
      <View style={[styles.avatar, isUser ? styles.avatarUser : styles.avatarBot]}>
        {isUser ? <User size={12} color={t.textTertiary} /> : <Bot size={12} color={t.accent} />}
      </View>

      {/* Column: tool chips, bubble, timestamp */}
      <View style={[styles.col, isUser && styles.colUser]}>
        {!isUser && m.tools && m.tools.length > 0 && (
          <View style={styles.toolTrail}>
            {m.tools.map((tt, i) => (
              <View key={i} style={styles.toolChip}>
                <CheckCircle size={10} color={tt.ok ? t.accent : t.danger} />
                <Text style={styles.toolChipText}>{prettifyToolLabel(tt.tool)}</Text>
              </View>
            ))}
          </View>
        )}

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
            <MarkdownView content={m.content} />
          )}
        </View>
      </View>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    list: { padding: 14, paddingBottom: 20 },
    empty: { alignItems: "center", justifyContent: "center", paddingVertical: 60, paddingHorizontal: 24 },
    emptyTitle: { fontSize: 18, fontWeight: "700", color: t.textSecondary },
    emptyHint: { fontSize: 13, color: t.textTertiary, textAlign: "center", marginTop: 8, lineHeight: 19 },

    // Row: avatar + column (reversed for user), matching the desktop bubble.
    row: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 14 },
    rowUser: { flexDirection: "row-reverse" },
    avatar: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", marginTop: 2, borderWidth: 1 },
    avatarBot: { backgroundColor: t.accentDim, borderColor: withAlpha(t.accent, 0.2) },
    avatarUser: { backgroundColor: t.surface3, borderColor: t.border },
    col: { flex: 1, minWidth: 0, gap: 6 },
    colUser: { alignItems: "flex-end" },

    toolTrail: { flexDirection: "column", gap: 4, alignSelf: "flex-start" },
    toolChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-start",
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    toolChipText: { fontSize: 12, color: t.textSecondary },

    bubble: { maxWidth: "94%", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14 },
    aiBubble: { backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderTopLeftRadius: 4, alignSelf: "flex-start" },
    userBubble: { backgroundColor: t.accent, borderTopRightRadius: 4, alignSelf: "flex-end" },
    userText: { color: t.accentFg, fontSize: 15, lineHeight: 21 },
    bubbleImages: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
    bubbleImg: { width: 120, height: 120, borderRadius: 8, backgroundColor: t.surface3 },
    previewStrip: { maxHeight: 84, marginHorizontal: 12 },
    previewContent: { gap: 8, paddingVertical: 6 },
    previewItem: { position: "relative" },
    previewImg: { width: 68, height: 68, borderRadius: 10, backgroundColor: t.surface3 },
    previewRemove: { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center" },
    attachBtn: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
    composer: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 8,
    },
    inputGlass: {
      flex: 1,
      minHeight: 48,
      maxHeight: 140,
      justifyContent: "center",
      borderRadius: 24,
      overflow: "hidden",
      backgroundColor: glassActive ? undefined : t.surface2,
      borderWidth: glassActive ? 0 : 1,
      borderColor: t.border,
    },
    input: {
      paddingHorizontal: 16,
      paddingVertical: 13,
      color: t.textPrimary,
      fontSize: 16,
      lineHeight: 21,
    },
    sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: t.accent, alignItems: "center", justifyContent: "center" },
    sendBtnDisabled: { opacity: 0.4 },
  });
}
