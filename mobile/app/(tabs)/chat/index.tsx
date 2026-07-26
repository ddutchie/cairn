import { useCallback, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
  ActionSheetIOS,
  Platform,
} from "react-native";
import { KeyboardController, KeyboardChatScrollView, KeyboardGestureArea } from "react-native-keyboard-controller";
import { Stack, useRouter, useFocusEffect } from "expo-router";
import { Settings2 } from "lucide-react-native";
import { TabScreen } from "@/components/TabScreen";
import { EmptyState } from "@/components/EmptyState";
import { ICON_DELETE, ICON_AI } from "@/components/toolbar-icons";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { runAgent, userMessage, type AgentEvent, type Attachment } from "@/chat/agent";
import { haptics, toolbarPress } from "@/haptics";
import { pickImages, takePhoto } from "@/chat/attachments";
import { saveChatMessage, clearChatHistory, loadLastChatUsage, saveLastChatUsage, type ToolCall } from "@/db/chat-store";
import { hasProvider } from "@/chat/providers";
import { resetAppleSession } from "@/chat/providers/apple";
import type { UIMessage, ChatUsage } from "@/chat/providers/types";
import { ContextRing } from "@/components/ContextRing";
import { toolRef } from "@cairn/shared/chat/tool-ref";
import { extractExternalRef } from "@cairn/shared/chat/external-ref";
import { loadInitialChat, type UiMessage } from "@/chat/history";
import { useChatScroll } from "@/chat/useChatScroll";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { Composer } from "@/components/chat/Composer";

export default function ChatScreen() {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();

  // Restore local (on-device) chat history once, synchronously, when the screen
  // first mounts — seeding both the UI bubbles (messages) and the persistent
  // agent conversation (ref) from a SINGLE history read. A lazy useState
  // initializer is guaranteed to run exactly once (unlike useMemo, which React
  // may discard and recompute), so the DB read happens once and both seeds below
  // share the same result.
  const [initial] = useState(() => loadInitialChat());
  const [messages, setMessages] = useState<UiMessage[]>(initial.uiMessages);
  const conversation = useRef<UIMessage[]>(null as unknown as UIMessage[]);
  if (conversation.current === null) {
    conversation.current = initial.conversation;
  }

  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState(true);
  // Context-window usage for the ring (Apple provider reports it per turn).
  // Seeded from the last persisted value so the ring survives closing/reopening
  // the Chat tab (it's session state otherwise, lost on unmount).
  const [usage, setUsage] = useState<ChatUsage | null>(() => loadLastChatUsage());

  // All keyboard/scroll choreography (resume repaint, follow-end, composer
  // height → transcript padding, attach-menu counter-transform).
  const {
    scrollRef,
    resumeKey,
    nearBottom,
    offset,
    extraContentPadding,
    attachCounterStyle,
    closedLift,
    setComposerH,
    followEnd,
    scrollToEndSoon,
  } = useChatScroll(messages.length);

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
        KeyboardController.dismiss().catch(() => { });
      };
    }, [refreshConfigured]),
  );

  const send = useCallback(async () => {
    const text = input.trim();
    const atts = attachments;
    if ((!text && atts.length === 0) || busy) return;
    haptics.selection(); // message sent
    // Dismiss via the keyboard-controller API (not RN's Keyboard.dismiss, which
    // can desync with this library and leave the keyboard stuck open until an
    // app switch). Fire-and-forget; don't block the send.
    KeyboardController.dismiss().catch(() => { });
    followEnd(); // sending jumps to the end; follow the reply
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
        } else if (e.type === "tool-start" && e.tool) {
          // Show a "running" chip immediately so slow tools (MCP / web search)
          // aren't invisible until they finish.
          toolTrail.push({ tool: e.tool, ok: true, id: e.toolCallId, running: true });
          patchAssistant({ tools: [...toolTrail] });
          haptics.impact(); // agent started a tool
        } else if (e.type === "tool" && e.tool) {
          const ok = !(e.result && typeof e.result === "object" && "error" in (e.result as object));
          // A note/card ref opens in-app; otherwise try for a linkable external
          // URL (web-search hit, docs page, …) the chip can open in the browser.
          const ref = toolRef(e.tool, e.args, e.result);
          const externalRef = ref
            ? undefined
            : extractExternalRef(typeof e.result === "string" ? e.result : JSON.stringify(e.result ?? null));
          // Finalize the matching "running" chip in place (by tool-call id);
          // fall back to appending if no start was seen (provider-ran tools).
          const idx = e.toolCallId ? toolTrail.findIndex((c) => c.id === e.toolCallId && c.running) : -1;
          const finalized = { tool: e.tool, ok, id: e.toolCallId, running: false, ref, externalRef };
          if (idx >= 0) toolTrail[idx] = finalized;
          else toolTrail.push(finalized);
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
        setTimeout(() => scrollToEndSoon(true), 20);
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
      setTimeout(() => scrollToEndSoon(true), 50);
    }
  }, [input, attachments, busy, followEnd, scrollToEndSoon]);

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

  const removeAttachment = useCallback((idx: number) => setAttachments((prev) => prev.filter((_, i) => i !== idx)), []);

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

  const canSend = (!!input.trim() || attachments.length > 0) && !busy;

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
        <KeyboardGestureArea interpolator="ios" style={StyleSheet.absoluteFill}>
          <KeyboardChatScrollView
            ref={scrollRef}
            style={styles.scroll}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            keyboardLiftBehavior="whenAtEnd"
            offset={offset}
            extraContentPadding={extraContentPadding}
            scrollEventThrottle={16}
            onEndVisible={(visible) => { nearBottom.current = visible; }}
            onContentSizeChange={() => {
              // Follow new content only when the user is already near the bottom
              // (e.g. streaming) — never when they've scrolled up to read/expand.
              if (nearBottom.current) scrollToEndSoon(true);
            }}
          >
            {messages.length === 0 ? null : (
              // Remount ONLY the message content (not the KeyboardChatScrollView)
              // on resume, keyed by resumeKey. This invalidates the stale iOS
              // Liquid-Glass backdrop the composer samples over the transformed
              // content (the "ghost bands" artifact) WITHOUT tearing down the
              // scroll view — remounting the scroll view itself reset its native
              // layout/content-size state (which onContentSizeChange doesn't
              // always re-fire for identical content), leaving the keyboard
              // engine unable to lift content above the keyboard until a cold
              // app relaunch forced a native re-layout.
              <View key={resumeKey}>
                {messages.map((m, i) => <MessageBubble key={i} m={m} />)}
              </View>
            )}
          </KeyboardChatScrollView>
        </KeyboardGestureArea>

        {/* Empty state is a SIBLING of the scroll view (not a child) and pinned
            as an absolute overlay, so the keyboard-driven content inset that
            KeyboardChatScrollView applies never shifts it around. Rendered AFTER
            (on top of) the absolute-fill KeyboardGestureArea so it paints above
            the scroll view — otherwise the scroll view would cover it and swallow
            taps on the "Set up AI" button. It only shows when there are no
            messages; once a conversation exists the scroll view's content takes
            over. `pointerEvents="box-none"` (in EmptyState) lets taps fall
            through the blank areas to the composer / scroll view beneath, while
            the Cairn icon and "Set up AI" button stay tappable. */}
        {messages.length === 0 ? (
          <EmptyState
            title="Ask Cairn"
            subtitle="Ask about your notes, or tell the assistant to create or edit them. Changes sync to your desktop."
            pinned
          >
            {!configured ? (
              <Pressable style={styles.configureBtn} onPress={() => router.push("/settings/ai")}>
                <Settings2 size={14} color={t.accentFg} />
                <Text style={styles.configureBtnText}>Set up AI</Text>
              </Pressable>
            ) : null}
          </EmptyState>
        ) : null}

        <Composer
          input={input}
          onChangeInput={setInput}
          attachments={attachments}
          onRemoveAttachment={removeAttachment}
          busy={busy}
          canSend={canSend}
          onSend={send}
          // Mark intent to follow the latest message; the actual lift above the
          // keyboard is handled natively by KeyboardChatScrollView.
          onInputFocus={followEnd}
          onAddImages={addImages}
          onCapturePhoto={capturePhoto}
          onAttachFallback={onAttach}
          attachCounterStyle={attachCounterStyle}
          closedLift={closedLift}
          onLayoutHeight={setComposerH}
        />
      </View>
    </TabScreen>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    // flex:1 (not absoluteFill) so the scroll viewport has a deterministic height
    // that tracks the parent box — the library's inner container is flexGrow/
    // flexShrink with no fixed height, so an absolutely-filled outer left the
    // viewport measurement lagging content/keyboard-inset changes (chat "wrong
    // size"). It sits inside the absoluteFill KeyboardGestureArea.
    scroll: { flex: 1 },
    list: { padding: 14, paddingBottom: 20 },
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
  });
}
