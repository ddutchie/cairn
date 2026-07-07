import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { KeyboardStickyView, useKeyboardHandler } from "react-native-keyboard-controller";
import { Stack, useRouter, useFocusEffect } from "expo-router";
import { CheckCircle, Bot, User, Send, ImagePlus, X, Settings2 } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TabScreen } from "@/components/TabScreen";
import { GlassBar, glassActive } from "@/components/GlassBar";
import { MarkdownView } from "@/components/MarkdownView";
import { ICON_DELETE, ICON_AI } from "@/components/toolbar-icons";
import { useTheme, withAlpha, type as typeScale, type Theme } from "@/theme";
import { runAgent, userMessage, assistantMessage, type AgentEvent, type Attachment } from "@/chat/agent";
import { pickImages, takePhoto } from "@/chat/attachments";
import { loadChatHistory, saveChatMessage, clearChatHistory } from "@/db/chat-store";
import { hasProvider } from "@/chat/providers";
import { prettifyToolLabel } from "@cairn/shared/ui/constants";
import type { UIMessage } from "@/chat/providers/types";

/** Standard UIKit tab bar content height (excludes the home-indicator inset). */
const TAB_BAR_BASE = 49;
/** Composer height assumed before its first onLayout measurement. */
const COMPOSER_FALLBACK_H = 60;

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
  const [configured, setConfigured] = useState(true);
  const scrollRef = useRef<ScrollView>(null);
  const router = useRouter();
  // Persistent agent conversation (UIMessage parts format) across turns.
  const conversation = useRef<UIMessage[]>([]);

  // Whether any AI provider is usable (built-in Rork or a configured OpenAI
  // key). Re-checked whenever the chat screen regains focus — e.g. after the
  // AI settings form-sheet route is dismissed.
  const refreshConfigured = useCallback(() => {
    hasProvider().then(setConfigured).catch(() => setConfigured(false));
  }, []);
  useFocusEffect(
    useCallback(() => {
      refreshConfigured();
    }, [refreshConfigured]),
  );

  // Restore local (on-device) chat history once on mount: rebuild both the UI
  // bubbles and the agent conversation so context survives an app relaunch.
  useEffect(() => {
    const history = loadChatHistory();
    if (history.length === 0) return;
    setMessages(history.map((h) => ({ role: h.role, content: h.content, images: h.images, tools: h.tools })));
    for (const h of history) {
      if (h.role === "user") {
        // Restore image attachments too, so the agent keeps multimodal context
        // across relaunch (the UI bubble already shows them via setMessages).
        const atts = (h.images ?? []).map((url) => ({
          url,
          mediaType: url.match(/^data:([^;,]+)/)?.[1] ?? "image/jpeg",
        }));
        conversation.current.push(userMessage(h.content, atts));
      } else {
        conversation.current.push(assistantMessage(h.content));
      }
    }
  }, []);

  const { height: kbHeight } = useGradualAnimation();
  // Approximate the native (translucent) iOS tab bar height. NativeTabs doesn't
  // expose BottomTabBarHeightContext, so we reconstruct it: the standard UIKit
  // tab bar is 49pt tall and sits above the home-indicator safe area.
  //
  // Lift the composer just above the tab bar when the keyboard is closed. We
  // lift by only slightly more than the bar's visible height (not the full
  // safe-area-inclusive height) so the composer hugs the bar instead of
  // floating well above it.
  const closedLift = TAB_BAR_BASE + insets.bottom * 0.5;
  // Height the composer occupies, measured lazily (falls back before layout).
  const [composerH, setComposerH] = useState(COMPOSER_FALLBACK_H);
  // Animated spacer at the BOTTOM of the scroll content. It always keeps the
  // last message clear of the floating composer, and grows to clear the
  // keyboard when it opens (so you can scroll the newest message above the
  // keyboard). When closed it matches where the composer actually rests
  // (closedLift above the screen bottom) so there's no dead space.
  const bottomSpacer = useAnimatedStyle(() => ({
    height: composerH + 12 + Math.max(kbHeight.value, closedLift),
  }), [composerH, closedLift]);

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
    // Persist the user turn locally (on-device only — chat never syncs).
    saveChatMessage({ role: "user", content: text, images: atts.map((a) => a.url) });
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
      const finalText = answer || acc;
      patchAssistant({ content: finalText, streaming: false, tools: toolTrail.length ? toolTrail : undefined });
      saveChatMessage({ role: "assistant", content: finalText, tools: toolTrail.length ? toolTrail : undefined });
    } catch (e) {
      const msg = e instanceof Error && /network|fetch|failed/i.test(e.message)
        ? "Chat needs a connection. Reconnect and try again."
        : `Error: ${e instanceof Error ? e.message : String(e)}`;
      patchAssistant({ content: msg, streaming: false });
      saveChatMessage({ role: "assistant", content: msg });
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

  const onClear = useCallback(() => {
    if (messages.length === 0 || busy) return;
    Alert.alert("Clear chat?", "This deletes the on-device conversation history. It only affects this device.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          clearChatHistory();
          conversation.current = [];
          setMessages([]);
        },
      },
    ]);
  }, [messages.length, busy]);

  return (
    <TabScreen>
      <Stack.Screen options={{ title: "Chat" }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={ICON_DELETE}
          hidden={messages.length === 0}
          disabled={busy}
          accessibilityLabel="Clear chat"
          onPress={onClear}
        />
        <Stack.Toolbar.Button
          icon={ICON_AI}
          accessibilityLabel="AI settings"
          onPress={() => router.push("/settings/ai")}
        />
      </Stack.Toolbar>
      <View style={{ flex: 1 }}>
        {/* Full-height scroll: messages scroll BEHIND the sticky composer and
            the translucent native tab bar. The animated bottom spacer clears
            both the composer and (when open) the keyboard. */}
        <ScrollView
          ref={scrollRef}
          style={StyleSheet.absoluteFill}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {messages.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Ask Cairn</Text>
              <Text style={styles.emptyHint}>
                Ask about your notes, or tell the assistant to create or edit them. Changes sync to your
                desktop.
              </Text>
              {!configured && (
                <Pressable style={styles.configureBtn} onPress={() => router.push("/settings/ai")}>
                  <Settings2 size={14} color={t.accentFg} />
                  <Text style={styles.configureBtnText}>Set up AI</Text>
                </Pressable>
              )}
            </View>
          ) : (
            messages.map((m, i) => <Bubble key={i} m={m} t={t} styles={styles} />)
          )}
          <Animated.View style={bottomSpacer} />
        </ScrollView>

        {/* Sticky composer: pinned to the bottom, rides up with the keyboard
            automatically. When the keyboard is closed it's offset up above the
            translucent tab bar; when open it sits flush on the keyboard. */}
        <KeyboardStickyView
          offset={{ closed: -closedLift, opened: 0 }}
          style={styles.composerOverlay}
        >
          <View onLayout={(e) => setComposerH(e.nativeEvent.layout.height)}>
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

            <View style={styles.composerWrap}>
              <GlassBar style={styles.composer} interactive={false}>
                <Pressable style={styles.attachBtn} onPress={onAttach} disabled={busy} hitSlop={6}>
                  <ImagePlus size={16} color={busy ? withAlpha(t.textTertiary, 0.5) : t.textTertiary} />
                </Pressable>
                <TextInput
                  style={styles.input}
                  value={input}
                  onChangeText={setInput}
                  placeholder="Message Cairn…"
                  placeholderTextColor={t.textTertiary}
                  multiline
                  editable={!busy}
                />
                <Pressable
                  style={[styles.sendBtn, ((!input.trim() && attachments.length === 0) || busy) && styles.sendBtnDisabled]}
                  onPress={send}
                  disabled={(!input.trim() && attachments.length === 0) || busy}
                >
                  {busy ? <ActivityIndicator color={t.accentFg} size="small" /> : <Send size={14} color={t.accentFg} />}
                </Pressable>
              </GlassBar>
            </View>
          </View>
        </KeyboardStickyView>
      </View>
    </TabScreen>
  );
}

// Memoised so a stream-token setMessages (which replaces only the streaming
// assistant message object) re-renders just that one bubble — not every prior
// message, each of which would otherwise re-run its MarkdownView parse per token.
const Bubble = memo(function Bubble({ m, t, styles }: { m: UiMessage; t: Theme; styles: ReturnType<typeof makeStyles> }) {
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
                <Text style={styles.toolChipText}>{prettifyToolLabel(tt.tool, { prettifyBare: true })}</Text>
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
});

function makeStyles(t: Theme) {
  return StyleSheet.create({
    list: { padding: 14, paddingBottom: 20 },
    empty: { alignItems: "center", justifyContent: "center", paddingVertical: 60, paddingHorizontal: 24 },
    emptyTitle: { ...typeScale.title, fontWeight: "700", color: t.textSecondary },
    emptyHint: { ...typeScale.caption, color: t.textTertiary, textAlign: "center", marginTop: 8, lineHeight: 19 },
    configureBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: 18,
      backgroundColor: t.accent,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 12,
    },
    configureBtnText: { ...typeScale.control, color: t.accentFg },

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
    toolChipText: { ...typeScale.caption, color: t.textSecondary },

    bubble: { maxWidth: "94%", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14 },
    aiBubble: { backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderTopLeftRadius: 4, alignSelf: "flex-start" },
    userBubble: { backgroundColor: t.accent, borderTopRightRadius: 4, alignSelf: "flex-end" },
    userText: { ...typeScale.body, lineHeight: 21, color: t.accentFg },
    bubbleImages: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
    bubbleImg: { width: 120, height: 120, borderRadius: 8, backgroundColor: t.surface3 },
    previewStrip: { maxHeight: 84, marginHorizontal: 12 },
    previewContent: { gap: 8, paddingVertical: 6 },
    previewItem: { position: "relative" },
    previewImg: { width: 68, height: 68, borderRadius: 10, backgroundColor: t.surface3 },
    previewRemove: { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center" },
    // The composer overlay is absolutely pinned to the bottom of the screen and
    // lifted above the tab bar / keyboard via an animated transform. It sits ON
    // TOP of the scroll content so messages scroll behind it.
    composerOverlay: { position: "absolute", left: 0, right: 0, bottom: 0 },
    // Outer padding around the pinned composer (mirrors desktop overview `p-6`
    // overlay, trimmed for mobile).
    composerWrap: { paddingHorizontal: 12, paddingTop: 8 },
    // Single unified rounded container holding attach + input + send inline,
    // mirroring the desktop overview ChatInput: rounded-2xl (16px), frosted
    // surface-2 at ~85%, 1px border, soft drop shadow. Buttons align to the
    // bottom edge (items-end) so a multiline field grows upward.
    composer: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 10,
      paddingHorizontal: 8,
      paddingVertical: 8,
      borderRadius: 16,
      overflow: "hidden",
      backgroundColor: glassActive ? undefined : withAlpha(t.surface2, 0.92),
      borderWidth: 1,
      borderColor: t.border,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.12,
      shadowRadius: 30,
      elevation: 4,
    },
    input: {
      flex: 1,
      minHeight: 36,
      maxHeight: 132,
      color: t.textPrimary,
      ...typeScale.body,
      lineHeight: 21,
      paddingVertical: 6,
      paddingHorizontal: 2,
    },
    // 32px rounded-xl (12px) icon buttons, vertically centred against the input.
    attachBtn: {
      width: 32,
      height: 32,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      alignSelf: "center",
    },
    sendBtn: {
      width: 32,
      height: 32,
      borderRadius: 12,
      backgroundColor: t.accent,
      alignItems: "center",
      justifyContent: "center",
      alignSelf: "center",
    },
    sendBtnDisabled: { opacity: 0.4 },
  });
}
