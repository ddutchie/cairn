import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
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
  ActionSheetIOS,
  Platform,
} from "react-native";
import { useSharedValue, withTiming } from "react-native-reanimated";
import { KeyboardStickyView, KeyboardController, KeyboardChatScrollView, KeyboardGestureArea } from "react-native-keyboard-controller";
import { Stack, useRouter, useFocusEffect } from "expo-router";
import { CheckCircle, Bot, User, Send, ImagePlus, X, Settings2, Brain, ChevronRight } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TabScreen } from "@/components/TabScreen";
import { EmptyState } from "@/components/EmptyState";
import { GlassBar, glassActive } from "@/components/GlassBar";
import { MarkdownView } from "@/components/MarkdownView";
import { ICON_DELETE, ICON_AI } from "@/components/toolbar-icons";
import { useTheme, withAlpha, tabBarClosedLift, KEYBOARD_OPEN_GAP, type as typeScale, type Theme } from "@/theme";
import { runAgent, userMessage, assistantMessage, type AgentEvent, type Attachment } from "@/chat/agent";
import { haptics, toolbarPress } from "@/haptics";
import { pickImages, takePhoto } from "@/chat/attachments";
import { loadChatHistory, saveChatMessage, clearChatHistory, loadLastChatUsage, saveLastChatUsage, type ToolCall } from "@/db/chat-store";
import { hasProvider } from "@/chat/providers";
import { resetAppleSession } from "@/chat/providers/apple";
import { prettifyToolLabel } from "@cairn/shared/ui/constants";
import type { UIMessage, ChatUsage } from "@/chat/providers/types";
import { ContextRing } from "@/components/ContextRing";

/** Composer height assumed before its first onLayout measurement. */
const COMPOSER_FALLBACK_H = 60;

/** Tools whose result/args point at a NOTE, and whether the id is in args or result. */
const NOTE_TOOLS: Record<string, "args" | "result"> = {
  ensure_note: "result",
  create_note: "result",
  get_note: "args",
  append_to_note: "args",
  patch_note: "args",
  rename_note: "args",
};
/** Tools whose result points at a CARD. */
const CARD_TOOLS: Record<string, "args" | "result"> = {
  create_task: "result",
  get_task: "args",
  update_task: "args",
};

/** Pull a string `id` field out of an unknown args/result object. */
function idFrom(obj: unknown): string | null {
  if (obj && typeof obj === "object" && "id" in obj) {
    const id = (obj as { id: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/**
 * Derive a navigable note/card ref from a completed tool call, so the tool chip
 * can open the thing it created/touched — the reliable, id-based path (no title
 * matching). Returns undefined for read-only / non-navigable tools.
 */
function toolRef(tool: string, args: unknown, result: unknown): ToolCall["ref"] | undefined {
  // Never navigate to an errored tool.
  if (result && typeof result === "object" && "error" in (result as object)) return undefined;
  const noteWhere = NOTE_TOOLS[tool];
  if (noteWhere) {
    const id = idFrom(noteWhere === "args" ? args : result);
    if (id) return { kind: "note", id };
  }
  const cardWhere = CARD_TOOLS[tool];
  if (cardWhere) {
    const id = idFrom(cardWhere === "args" ? args : result);
    if (id) return { kind: "card", id };
  }
  return undefined;
}

interface UiMessage {
  role: "user" | "assistant";
  content: string;
  images?: string[]; // data URIs for user attachments
  tools?: ToolCall[];
  /** Live reasoning ("thinking") text for turns whose model streams it (Apple
   *  PCC, or OpenAI-compatible endpoints exposing reasoning/reasoning_content).
   *  Shown collapsibly; like images it's session-only and not persisted. */
  reasoning?: string;
  streaming?: boolean;
}

export default function ChatScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(t), [t]);
  // Restore local (on-device) chat history once, synchronously, when the screen
  // first mounts — seeding both the UI bubbles (messages) and the persistent
  // agent conversation (ref) via lazy initializers rather than a
  // setState-in-effect (which the linter flags as a cascading render).
  // `useState`'s lazy initializer runs exactly once, so history is read a single
  // time and shared by both seeds below.
  const [messages, setMessages] = useState<UiMessage[]>(() =>
    loadChatHistory().map((h) => ({ role: h.role, content: h.content, images: h.images, tools: h.tools })),
  );
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState(true);
  // Context-window usage for the ring (Apple provider reports it per turn).
  // Seeded from the last persisted value so the ring survives closing/reopening
  // the Chat tab (it's session state otherwise, lost on unmount).
  const [usage, setUsage] = useState<ChatUsage | null>(() => loadLastChatUsage());
  const scrollRef = useRef<ComponentRef<typeof KeyboardChatScrollView>>(null);
  // Whether the user is at/near the bottom of the transcript. Auto-follow on
  // content growth only when true, so expanding a past message's reasoning block
  // (or other layout changes while scrolled up) doesn't yank the view to the end.
  const nearBottom = useRef(true);
  const router = useRouter();
  // Persistent agent conversation (UIMessage parts format) across turns. Seeded
  // once from the same on-device history as `messages` above. A ref's argument
  // is evaluated on every render (only the first is kept), so the history
  // load/remap goes behind a null-sentinel one-time initializer instead.
  const conversation = useRef<UIMessage[]>(null as unknown as UIMessage[]);
  if (conversation.current === null) {
    conversation.current = loadChatHistory().map((h) => {
      if (h.role === "user") {
        // Restore image attachments too, so the agent keeps multimodal context
        // across relaunch (the UI bubble already shows them via `messages`).
        const atts = (h.images ?? []).map((url) => ({
          url,
          mediaType: url.match(/^data:([^;,]+)/)?.[1] ?? "image/jpeg",
        }));
        return userMessage(h.content, atts);
      }
      return assistantMessage(h.content);
    });
  }

  // Whether any AI provider is usable (built-in Rork or a configured OpenAI
  // key). Re-checked whenever the chat screen regains focus — e.g. after the
  // AI settings form-sheet route is dismissed.
  const refreshConfigured = useCallback(() => {
    hasProvider().then(setConfigured).catch(() => setConfigured(false));
  }, []);
  useFocusEffect(
    useCallback(() => {
      refreshConfigured();
      // On blur (e.g. switching tabs/apps) make sure the keyboard doesn't linger
      // stuck-open — dismiss via the keyboard-controller API on the way out.
      return () => {
        KeyboardController.dismiss().catch(() => {});
      };
    }, [refreshConfigured]),
  );

  // Lift the composer just above the tab bar when the keyboard is closed
  // (shared with the search scope bar so both rest at the same height).
  const closedLift = tabBarClosedLift(insets.bottom);
  // Height the composer occupies, measured lazily (falls back before layout).
  const [composerH, setComposerH] = useState(COMPOSER_FALLBACK_H);
  // Bottom padding the transcript keeps clear below the last message so it's not
  // hidden by the floating composer. This is the CLOSED-keyboard clearance:
  // composer height + margin + where the composer rests above the tab bar
  // (closedLift). When the keyboard opens, KeyboardChatScrollView adds
  // (keyboardHeight - offset); with offset = closedLift - KEYBOARD_OPEN_GAP that
  // resolves to composerH + 12 + keyboardHeight + KEYBOARD_OPEN_GAP — i.e. the
  // content clears the composer (which itself rides KEYBOARD_OPEN_GAP above the
  // keyboard) without double-counting closedLift. Shared value because the
  // component consumes it on the UI thread.
  const extraContentPadding = useSharedValue(COMPOSER_FALLBACK_H + 12 + closedLift);
  useEffect(() => {
    // Animate (not snap) so the transcript padding eases when the composer grows
    // to multiple lines or the tab-bar lift changes, matching the keyboard's own
    // motion instead of jumping.
    extraContentPadding.value = withTiming(composerH + 12 + closedLift);
  }, [composerH, closedLift, extraContentPadding]);

  const send = useCallback(async () => {
    const text = input.trim();
    const atts = attachments;
    if ((!text && atts.length === 0) || busy) return;
    haptics.selection(); // message sent
    // Dismiss via the keyboard-controller API (not RN's Keyboard.dismiss, which
    // can desync with this library and leave the keyboard stuck open until an
    // app switch). Fire-and-forget; don't block the send.
    KeyboardController.dismiss().catch(() => {});
    nearBottom.current = true; // sending jumps to the end; follow the reply
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
    let reasoningAcc = "";
    const toolTrail: ToolCall[] = [];

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
        } else if (e.type === "reasoning-delta" && e.delta) {
          reasoningAcc += e.delta;
          patchAssistant({ reasoning: reasoningAcc });
        } else if (e.type === "tool" && e.tool) {
          const ok = !(e.result && typeof e.result === "object" && "error" in (e.result as object));
          toolTrail.push({ tool: e.tool, ok, ref: toolRef(e.tool, e.args, e.result) });
          patchAssistant({ tools: [...toolTrail] });
          haptics.impact(); // agent ran a tool
        } else if (e.type === "final" && e.usage) {
          // Only drive the ring with valid token counts — a negative prompt
          // count or non-positive limit renders a broken/empty ring.
          const u = e.usage;
          if (u.promptTokens >= 0 && u.contextLimit > 0) {
            setUsage(u);
            saveLastChatUsage(u); // persist so the ring survives tab close/reopen
          }
        }
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 20);
      };
      const answer = await runAgent(conversation.current, onEvent);
      const finalText = answer || acc;
      patchAssistant({ content: finalText, streaming: false, tools: toolTrail.length ? toolTrail : undefined });
      saveChatMessage({ role: "assistant", content: finalText, tools: toolTrail.length ? toolTrail : undefined });
      haptics.success(); // response received
    } catch (e) {
      const msg = e instanceof Error && /network|fetch|failed/i.test(e.message)
        ? "Chat needs a connection. Reconnect and try again."
        : `Error: ${e instanceof Error ? e.message : String(e)}`;
      patchAssistant({ content: msg, streaming: false });
      saveChatMessage({ role: "assistant", content: msg });
      haptics.error(); // request failed
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

  // Opens the "add image" chooser. Uses the native iOS action sheet (matches the
  // system look of the old SwiftUI glass menu) and falls back to an Alert
  // elsewhere. Deliberately NOT a SwiftUI menu Host: the composer rides the
  // keyboard via KeyboardStickyView's transform, and a native Host anchored in
  // window coords jumps out of place once its menu re-measures — a plain RN
  // Pressable trigger tracks the transform exactly like the send button does.
  const onAttach = useCallback(() => {
    haptics.selection();
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["Photo Library", "Take Photo", "Cancel"], cancelButtonIndex: 2, title: "Add image" },
        (i) => {
          if (i === 0) void addImages();
          else if (i === 1) void capturePhoto();
        },
      );
      return;
    }
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
          haptics.warning();
          clearChatHistory();
          conversation.current = [];
          setMessages([]);
          setUsage(null);
          // Drop the on-device session so a new chat gets a fresh context window.
          resetAppleSession();
        },
      },
    ]);
  }, [messages.length, busy]);

  return (
    <TabScreen>
      <Stack.Screen
        options={{
          title: "Chat",
          // Context-window usage ring in the header-left when the active provider
          // reports usage (Apple real, OpenAI real, Rork estimated).
          headerLeft:
            usage && messages.length > 0
              ? () => (
                  <ContextRing
                    promptTokens={usage.promptTokens}
                    contextLimit={usage.contextLimit}
                    estimated={usage.estimated}
                  />
                )
              : undefined,
        }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={ICON_DELETE}
          hidden={messages.length === 0}
          disabled={busy}
          accessibilityLabel="Clear chat"
          // Inline arrow (not a bare toolbarPress(onClear)) so the react-hooks
          // ref lint doesn't flag onClear's transitive ref access during render.
          onPress={() => toolbarPress(onClear)()}
        />
        <Stack.Toolbar.Button
          icon={ICON_AI}
          accessibilityLabel="AI settings"
          onPress={toolbarPress(() => router.push("/settings/ai"))}
        />
      </Stack.Toolbar>
      <View style={{ flex: 1 }}>
        {/* Full-height chat scroll: messages scroll BEHIND the sticky composer
            and the translucent native tab bar. KeyboardChatScrollView manages
            the keyboard lift natively via content inset (keyboardLiftBehavior
            "whenAtEnd" = only follow the bottom when the user is already there,
            ChatGPT-style), so the last message stays visible above the keyboard.
            extraContentPadding keeps the last message clear of the floating
            composer even when the keyboard is closed. Wrapped in
            KeyboardGestureArea (full-region) so keyboardDismissMode="interactive"
            gets proper swipe-to-dismiss gesture handling (per the library's chat
            example) — iOS follow-finger + Android gesture control. */}
        <KeyboardGestureArea
          interpolator="ios"
          style={StyleSheet.absoluteFill}
        >
          <KeyboardChatScrollView
            ref={scrollRef}
            style={StyleSheet.absoluteFill}
            contentContainerStyle={[styles.list, messages.length === 0 && styles.listEmpty]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            keyboardLiftBehavior="whenAtEnd"
            offset={Math.max(closedLift - KEYBOARD_OPEN_GAP, 0)}
            extraContentPadding={extraContentPadding}
            scrollEventThrottle={16}
            onEndVisible={(visible) => { nearBottom.current = visible; }}
            onContentSizeChange={() => {
              // Follow new content only when the user is already near the bottom
              // (e.g. streaming) — never when they've scrolled up to read/expand.
              if (nearBottom.current) scrollRef.current?.scrollToEnd({ animated: true });
            }}
          >
            {messages.length === 0 ? (
              <EmptyState
                title="Ask Cairn"
                subtitle="Ask about your notes, or tell the assistant to create or edit them. Changes sync to your desktop."
                align="top"
              >
                {!configured ? (
                  <Pressable style={styles.configureBtn} onPress={() => router.push("/settings/ai")}>
                    <Settings2 size={14} color={t.accentFg} />
                    <Text style={styles.configureBtnText}>Set up AI</Text>
                  </Pressable>
                ) : null}
              </EmptyState>
            ) : (
              messages.map((m, i) => <Bubble key={i} m={m} t={t} styles={styles} />)
            )}
          </KeyboardChatScrollView>
        </KeyboardGestureArea>

        {/* Sticky composer: pinned to the bottom, rides up with the keyboard
            automatically. When the keyboard is closed it's offset up above the
            translucent tab bar; when open it sits just above the keyboard with a
            small gap (KEYBOARD_OPEN_GAP), matching the search scope bar. */}
        <KeyboardStickyView
          offset={{ closed: -closedLift, opened: -KEYBOARD_OPEN_GAP }}
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
                {/* Plain RN Pressable trigger (NOT a SwiftUI menu Host): it rides
                    the KeyboardStickyView transform exactly like the send button,
                    so it can't drift when the keyboard opens. Tapping opens the
                    native photo action sheet. */}
                <Pressable
                  style={styles.attachBtn}
                  onPress={onAttach}
                  disabled={busy}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Add image"
                >
                  <ImagePlus size={16} color={busy ? withAlpha(t.textTertiary, 0.5) : t.textTertiary} />
                </Pressable>
                <TextInput
                  style={styles.input}
                  value={input}
                  onChangeText={setInput}
                  onFocus={() => {
                    // Mark intent to follow the latest message; the actual lift
                    // above the keyboard is handled natively by
                    // KeyboardChatScrollView (keyboardLiftBehavior="whenAtEnd").
                    nearBottom.current = true;
                  }}
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
/**
 * Collapsible "reasoning" (thinking) disclosure for models that stream it
 * (Apple PCC, or OpenAI-compatible endpoints like DeepSeek/OpenRouter).
 * Expanded while the answer is still streaming so the user sees the model think;
 * collapses to a one-line summary once done. Session-only (not persisted).
 */
function ReasoningBlock({
  text,
  streaming,
  t,
  styles,
}: {
  text: string;
  streaming?: boolean;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
}) {
  const [open, setOpen] = useState(false);
  const expanded = open || !!streaming;
  return (
    <View style={styles.reasoning}>
      <Pressable
        style={styles.reasoningHeader}
        onPress={() => setOpen((v) => !v)}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={expanded ? "Hide reasoning" : "Show reasoning"}
        accessibilityState={{ expanded }}
      >
        <Brain size={11} color={t.textTertiary} />
        <Text style={styles.reasoningLabel}>{streaming ? "Thinking…" : "Reasoning"}</Text>
        <ChevronRight
          size={12}
          color={t.textTertiary}
          style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}
        />
      </Pressable>
      {expanded ? <Text style={styles.reasoningText}>{text}</Text> : null}
    </View>
  );
}

const Bubble = memo(function Bubble({ m, t, styles }: { m: UiMessage; t: Theme; styles: ReturnType<typeof makeStyles> }) {
  const isUser = m.role === "user";
  const router = useRouter();
  return (
    <View style={[styles.row, isUser && styles.rowUser]}>
      {/* Avatar */}
      <View style={[styles.avatar, isUser ? styles.avatarUser : styles.avatarBot]}>
        {isUser ? <User size={12} color={t.textTertiary} /> : <Bot size={12} color={t.accent} />}
      </View>

      {/* Column: tool chips, bubble, timestamp */}
      <View style={[styles.col, isUser && styles.colUser]}>
        {!isUser && m.reasoning ? (
          <ReasoningBlock text={m.reasoning} streaming={m.streaming} t={t} styles={styles} />
        ) : null}
        {!isUser && m.tools && m.tools.length > 0 && (
          <View style={styles.toolTrail}>
            {m.tools.map((tt, i) => {
              const label = prettifyToolLabel(tt.tool, { prettifyBare: true });
              // A tool that created/touched a note or card is tappable — opens
              // it by id (the reliable, collision-proof path).
              if (tt.ref) {
                return (
                  <Pressable
                    key={i}
                    style={styles.toolChip}
                    hitSlop={6}
                    onPress={() => {
                      haptics.impact();
                      router.push(tt.ref!.kind === "card" ? `/card/${tt.ref!.id}` : `/note/${tt.ref!.id}`);
                    }}
                  >
                    <CheckCircle size={10} color={tt.ok ? t.accent : t.danger} />
                    <Text style={[styles.toolChipText, styles.toolChipLink]}>{label}</Text>
                    <ChevronRight size={10} color={t.accent} />
                  </Pressable>
                );
              }
              return (
                <View key={i} style={styles.toolChip}>
                  <CheckCircle size={10} color={tt.ok ? t.accent : t.danger} />
                  <Text style={styles.toolChipText}>{label}</Text>
                </View>
              );
            })}
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
            <MarkdownView content={m.content} resolveLinks />
          )}
        </View>
      </View>
    </View>
  );
});

function makeStyles(t: Theme) {
  return StyleSheet.create({
    list: { padding: 14, paddingBottom: 20 },
    // Grow to fill the viewport when empty so the branded EmptyState's top-bias
    // measures against the full content area (below the header).
    listEmpty: { flexGrow: 1 },
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
    toolChipLink: { color: t.accent },

    reasoning: {
      alignSelf: "flex-start",
      maxWidth: "94%",
      gap: 4,
      marginBottom: 2,
      paddingLeft: 2,
    },
    reasoningHeader: { flexDirection: "row", alignItems: "center", gap: 5 },
    reasoningLabel: {
      ...typeScale.overline,
      color: t.textTertiary,
    },
    reasoningText: {
      ...typeScale.caption,
      color: t.textTertiary,
      fontStyle: "italic",
      lineHeight: 17,
      paddingLeft: 16,
    },

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
      // When Liquid Glass is active the GlassView is the visual container, so no
      // border/fill — the border only defines the fallback (non-glass) surface.
      backgroundColor: glassActive ? undefined : withAlpha(t.surface2, 0.92),
      borderWidth: glassActive ? 0 : 1,
      borderColor: glassActive ? undefined : t.border,
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
    // 32px rounded icon button, vertically centred against the input (alignSelf
    // overrides the row's flex-end so it doesn't ride up as the input grows). A
    // plain RN Pressable like sendBtn — no SwiftUI Host — so it tracks the
    // keyboard transform without drifting.
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
