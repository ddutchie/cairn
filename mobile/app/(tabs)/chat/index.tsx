import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
  useWindowDimensions,
} from "react-native";
import { KeyboardController, KeyboardChatScrollView, KeyboardGestureArea, useKeyboardState, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { LinearGradient } from "expo-linear-gradient";
import { Stack, useRouter, useFocusEffect } from "expo-router";
import { Settings, Settings2, Trash2 } from "lucide-react-native";
import { TabScreen } from "@/components/TabScreen";
import { EmptyState } from "@/components/EmptyState";
import { ICON_DELETE, ICON_AI } from "@/components/toolbar-icons";
import { useTheme, withAlpha, type as typeScale, type Theme, KEYBOARD_OPEN_GAP } from "@/theme";
import { runAgent, userMessage, type AgentEvent, type Attachment } from "@/chat/agent";
import { haptics, toolbarPress } from "@/haptics";
import { saveChatMessage, clearChatHistory, loadLastChatUsage, saveLastChatUsage, recordChatUsage, type ToolCall } from "@/db/chat-store";
import { redactValue } from "@cairn/shared/chat/redaction";
import { hasProvider, resolveProvider } from "@/chat/providers";
import { resetAppleSession } from "@/chat/providers/apple";
import { getOpenAIModel, getProviderPref, getActiveProvider } from "@/chat/ai-config";
import { isRorkAvailable } from "@/chat/providers/rork";
import { getModelInfo, getModelCatalogVersion, subscribeModelCatalog } from "@/chat/models-dev";
import { supportsImageInput } from "@cairn/shared/models/model-catalog";
import { type UIMessage, type ChatUsage, msgId } from "@/chat/providers/types";
import { ContextRing } from "@/components/ContextRing";
import { Glass } from "@/components/chat/attachment-panel/glass";
import { toolRef } from "@cairn/shared/chat/tool-ref";
import { extractExternalRef } from "@cairn/shared/chat/external-ref";
import { loadInitialChat, type UiMessage } from "@/chat/history";
import { useChatScroll } from "@/chat/useChatScroll";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { CairnMorphComposer } from "@/components/chat/CairnMorphComposer";
import { CairnAttachmentHost, type CairnAttachmentHostHandle } from "@/components/chat/attachment-panel/CairnAttachmentHost";
import { ChatPatternOverlay } from "@/components/chat/ChatPatternOverlay";
import { safeToolOutput } from "@/chat/tool-output";
import { fetchManifest } from "@/chat/registry";
import { useSharedValue, withSpring, useDerivedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { COMPOSER, SPRING } from "@/components/chat/attachment-panel/constants";
import { SidePreviewLayout, useSidePreview } from "@/components/SidePreview";
import { useFold, useTopHalf } from "@/lib/use-fold";

// Resolve the provider/model label for the chat-usage history (Usage screen).
function usageProviderLabel(): string {
  const pref = getProviderPref(isRorkAvailable());
  if (pref === "apple") return "Apple";
  if (pref === "rork") return "Rork";
  return getActiveProvider()?.name ?? "OpenAI";
}
function usageModelLabel(): string {
  const pref = getProviderPref(isRorkAvailable());
  return pref === "openai" ? getOpenAIModel() || "—" : pref;
}

/** Add two ChatUsage records (for accumulating spend across tool rounds). */
function sumUsage(a: ChatUsage, b: ChatUsage): ChatUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    contextLimit: b.contextLimit,
    completionTokens: (a.completionTokens ?? 0) + (b.completionTokens ?? 0),
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheCreationTokens: (a.cacheCreationTokens ?? 0) + (b.cacheCreationTokens ?? 0),
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) || undefined,
    estimated: a.estimated === true || b.estimated === true,
  };
}

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
  // Messages the user queued while a turn was running — sent (FIFO) when the
  // current reply finishes. Attachments are stored alongside so staged
  // images/PDFs are never silently dropped. Session-scoped.
  const [queued, setQueued] = useState<{ id: string; content: string; attachments?: Attachment[] }[]>([]);
  const queuedRef = useRef<typeof queued>([]);
  useEffect(() => { queuedRef.current = queued; }, [queued]);
  // Content + attachments for the next queued send — read by `send` when the
  // queue drains.
  const pendingSendRef = useRef<{ content: string; attachments?: Attachment[] } | null>(null);
  const [configured, setConfigured] = useState(true);
  // Context-window usage for the ring (Apple provider reports it per turn).
  // Seeded from the last persisted value so the ring survives closing/reopening
  // the Chat tab (it's session state otherwise, lost on unmount).
  const [usage, setUsage] = useState<ChatUsage | null>(() => loadLastChatUsage());
  const [, setRegistryRevision] = useState(0);

  // All keyboard/scroll choreography (resume repaint, follow-end, composer
  // height → transcript padding).
  const {
    scrollRef,
    resumeKey,
    nearBottom,
    offset,
    extraContentPadding,
    closedLift,
    setComposerH,
    followEnd,
    scrollToEndSoon,
  } = useChatScroll(messages.length);

  // Morph composer springs (strip + plusOut) + attachment host
  const strip = useSharedValue(0);
  const plusOut = useSharedValue(0);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  // Wide windows open touched notes/tasks in a column beside the chat (folding a
  // Duo with a preview open keeps it: the pane fills the window, its ✕ returns
  // to the conversation). Shared with Graph/Calendar — see SidePreview.
  const sp = useSidePreview({ title: "Chat", titleWhenWide: false });
  // Laptop pose (portrait half-fold): the transcript and empty state stay in the
  // upright top half; the composer and tab pill sit on the flat bottom half.
  const topHalf = useTopHalf();
  // Book pose (vertical crease): the composer's input and send button move wholly to
  // the far half instead of straddling the fold. The transcript still scrolls full
  // width. With a preview open the chat already sits left of the crease, so no shift.
  const fold = useFold();
  const composerLeftInset = fold?.axis === "vertical" && sp.preview == null ? fold.position + fold.gutter / 2 : 0;
  // With a preview stacked above the chat, the keyboard (the whole flat half)
  // belongs to whichever input is focused. Typing in the chat slides the preview
  // away (it stays mounted, drafts intact) so the conversation fills the top half
  // with its composer on the crease; while the note is being edited instead, the
  // composer hides rather than riding up over the editor.
  const keyboardVisible = useKeyboardState((s) => s.isVisible);
  const [inputFocused, setInputFocused] = useState(false);
  const hideComposer = sp.stacked && sp.preview != null && keyboardVisible && !inputFocused;
  // The transcript fills the window (scrolling under the crease is fine) until
  // the chat's own input has the keyboard; then it is confined above the crease,
  // since the composer rises onto it and the keyboard takes the flat half.
  const confined = topHalf.before != null && (inputFocused || keyboardVisible);
  const keyboardHeight = useKeyboardState((s) => s.height);
  // Once the fold layout has stopped moving (focus, pane collapse, keyboard), put the
  // latest message back at the end — if the user was following it.
  const foldLayoutKey = `${confined}|${sp.stacked && inputFocused}|${Math.round(topHalf.before ?? -1)}`;
  useEffect(() => {
    if (!sp.stacked && topHalf.before == null) return;
    const id = setTimeout(() => {
      if (nearBottom.current) scrollToEndSoon(false);
    }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldLayoutKey]);
  // Confined, the transcript needs no tab-bar clearance; it reserves only the part
  // of the composer that overlaps its bottom edge (the composer sits a little
  // above the keyboard, which starts below the crease), nothing otherwise.
  const [composerHeight, setComposerHeight] = useState(0);
  const topHalfPadding = useSharedValue(0);
  useEffect(() => {
    const overlap = Math.max(0, keyboardHeight + KEYBOARD_OPEN_GAP + composerHeight - topHalf.gap);
    // Instant, not eased: an animated inset runs in parallel with the layout
    // switch (pane collapse / confined area) and the scroll-to-end, and the transcript
    // visibly slides out of view before settling.
    topHalfPadding.set(inputFocused ? overlap + 12 : 0);
  }, [inputFocused, keyboardHeight, composerHeight, topHalf.gap, topHalfPadding]);
  const transcriptArea = confined
    ? ({ position: "absolute", top: 0, left: 0, right: 0, height: topHalf.before } as const)
    : StyleSheet.absoluteFill;
  const keyboard = useReanimatedKeyboardAnimation();
  const composerBottom = useDerivedValue(() => height - (Math.max(-keyboard.height.get(), insets.bottom) + COMPOSER.keyboardGap));
  const hostRef = useRef<CairnAttachmentHostHandle>(null);
  const composerInputRef = useRef<import("react-native").TextInputInstance>(null);
  useEffect(() => {
    strip.set(withSpring(attachments.length > 0 ? 1 : 0, SPRING.strip));
  }, [attachments.length, strip]);
  const onAddAttachments = useCallback((atts: Attachment[]) => {
    setAttachments((prev) => [...prev, ...atts].slice(0, 8));
  }, []);

  // Whether any AI provider is usable (built-in Rork or a configured OpenAI
  // key). Re-checked whenever the chat screen regains focus — e.g. after the
  // AI settings form-sheet route is dismissed.
  const refreshConfigured = useCallback(() => {
    hasProvider().then(setConfigured).catch(() => setConfigured(false));
  }, []);

  // Image attach is hidden when the ACTIVE provider is an OpenAI-compatible or
  // Responses endpoint and its model is known not to accept images. Rork /
  // Apple / unknown models stay permissive. Re-resolved on focus (provider may
  // change in settings).
  const [openAiModelActive, setOpenAiModelActive] = useState<string | null>(null);
  // Re-renders on catalog arrival/refresh; the version feeds the memo so
  // gating recomputes when a model's capabilities finally resolve.
  const catalogVersion = useSyncExternalStore(subscribeModelCatalog, getModelCatalogVersion);
  const allowImages = useMemo(
    () =>
      openAiModelActive == null ? true : supportsImageInput(getModelInfo(openAiModelActive)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openAiModelActive, catalogVersion],
  );

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      refreshConfigured();
      void fetchManifest(false).then(() => setRegistryRevision((revision) => revision + 1));
      resolveProvider()
        .then((p) => {
          if (!alive) return;
          // Both wire protocols built from an OpenAI config gate images on the
          // catalog model's capability — "Responses" is makeResponsesProvider().
          setOpenAiModelActive(p.name === "OpenAI-compatible" || p.name === "Responses" ? getOpenAIModel() : null);
        })
        .catch(() => {
          if (alive) setOpenAiModelActive(null);
        });
      // On blur (e.g. switching tabs/apps) make sure the keyboard doesn't linger
      // stuck-open — dismiss via the keyboard-controller API on the way out.
      return () => {
        alive = false;
        KeyboardController.dismiss().catch(() => { });
      };
    }, [refreshConfigured]),
  );

  const send = useCallback(async () => {
    const queuedSend = pendingSendRef.current;
    pendingSendRef.current = null;
    const text = (queuedSend?.content ?? input).trim();
    const atts = queuedSend?.attachments ?? attachments;
    if (!text && atts.length === 0) return;
    // A turn is already running — queue this message instead of interrupting
    // it. The queue drains (FIFO) when the current reply finishes.
    if (busy) {
      setQueued((prev) => [...prev, { id: msgId(), content: text, attachments: atts }]);
      setInput("");
      setAttachments([]);
      return;
    }
    haptics.selection(); // message sent
    // Dismiss via the keyboard-controller API (not RN's Keyboard.dismiss, which
    // can desync with this library and leave the keyboard stuck open until an
    // app switch). Fire-and-forget; don't block the send.
    KeyboardController.dismiss().catch(() => { });
    followEnd(); // sending jumps to the end; follow the reply
    // Only clear the composer when the user submitted their OWN draft — a
    // queue drain must not wipe a newer unsent draft.
    if (!queuedSend) {
      setInput("");
      setAttachments([]);
    }
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
    let reasoningSummaryAcc = "";
    const toolTrail: ToolCall[] = [];
    // Sum of per-round usage across the run (tool-calling turns emit one usage
    // event per round; the ring uses the final round, the history uses this sum).
    let usageTotal: ChatUsage | undefined = undefined;

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
        } else if (e.type === "reasoning-summary-delta" && e.delta) {
          reasoningSummaryAcc += e.delta;
          patchAssistant({ reasoningSummary: reasoningSummaryAcc });
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
           const finalized = {
             tool: e.tool,
             args: e.args && typeof e.args === "object" ? redactValue(e.args) as Record<string, unknown> : undefined,
             output: safeToolOutput(e.result),
             ok,
             id: e.toolCallId,
             running: false,
             ref,
             externalRef,
           };
          if (idx >= 0) toolTrail[idx] = finalized;
          else toolTrail.push(finalized);
          patchAssistant({ tools: [...toolTrail] });
          haptics.impact(); // agent ran a tool
        } else if (e.type === "usage" && e.usage) {
          // Accumulate the real spend across tool-calling rounds — each round
          // re-sends the whole conversation, so the last round alone under-
          // counts a tool-heavy turn.
          usageTotal = usageTotal ? sumUsage(usageTotal, e.usage) : e.usage;
        } else if (e.type === "final") {
          // Patch the condensed reasoning summary (arrives via reasoning-summary-
          // delta during streaming, or only in the final event on some providers).
          if (e.reasoningSummary) patchAssistant({ reasoningSummary: e.reasoningSummary });
          if (e.usage) {
            // Drive the ring with the FINAL round's context window (a negative
            // prompt count or non-positive limit renders a broken/empty ring).
            const u = e.usage;
            if (u.promptTokens >= 0 && u.contextLimit > 0) {
              setUsage(u);
              saveLastChatUsage(u); // persist so the ring survives tab close/reopen
            }
            // Record the SUMMED spend (falls back to the final round's usage when
            // only one usage event arrived — e.g. a plain single-turn reply).
            const total = usageTotal ?? u;
            if (total.promptTokens >= 0 && (total.completionTokens ?? 0) >= 0) {
              recordChatUsage(total, usageProviderLabel(), usageModelLabel());
            }
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

  // Drain the queue: when a turn finishes (busy went true → false), send the
  // next queued message. Keeps the queue on Stop and drains after errors too.
  const sendRef = useRef<() => void>(() => {});
  useEffect(() => { sendRef.current = send; }, [send]);
  const prevBusyRef = useRef(busy);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (wasBusy && !busy && queuedRef.current.length > 0) {
      const [next, ...rest] = queuedRef.current;
      setQueued(rest);
      pendingSendRef.current = { content: next.content, attachments: next.attachments };
      sendRef.current();
    }
  }, [busy]);

  const removeQueued = useCallback((qid: string) => {
    setQueued((prev) => prev.filter((q) => q.id !== qid));
  }, []);

  const removeAttachment = useCallback((idx: number) => setAttachments((prev) => prev.filter((_, i) => i !== idx)), []);
  const onPlusPress = useCallback(() => {
    haptics.selection();
    hostRef.current?.toggle();
  }, []);

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

  // canSend stays true while busy so sending queues the message instead of
  // being blocked — the queue drains when the current reply finishes.
  const canSend = !!input.trim() || attachments.length > 0;

  // Context-window ring (shared by the header and, with a preview open, the composer).
  const renderContextRing = (popoverArrowEdge: "top" | "bottom") =>
    usage && messages.length > 0 ? (
      <ContextRing
        popoverArrowEdge={popoverArrowEdge}
        promptTokens={usage.promptTokens}
        contextLimit={usage.contextLimit}
        estimated={usage.estimated}
        breakdown={usage.breakdown}
        completionTokens={usage.completionTokens}
        reasoningTokens={usage.reasoningTokens}
        costUsd={usage.costUsd}
        cacheReadTokens={usage.cacheReadTokens}
        cacheCreationTokens={usage.cacheCreationTokens}
      />
    ) : null;
  const contextRing = renderContextRing("top");
  // With a preview open the header's buttons have stepped aside (its bar is the
  // preview's), so the context ring and clear-chat sit left of the input bar. The
  // ring's popover opens upward: the composer is at the bottom of the screen/half.
  // While typing the preview is slid away, so the header is free again: the ring
  // and clear-chat return there as header items instead of sitting by the input.
  const typingCollapsed = sp.stacked && sp.preview != null && inputFocused;
  // Laptop pose (horizontal crease): the header sits in the upright top half, so the
  // chat's tools live in the bottom half instead (capsules either side of the tab
  // bar) whether or not a preview is stacked above. They're out of reach only while
  // the keyboard is up, and return when it goes.
  const laptop = fold?.axis === "horizontal";
  const showHeaderTools = !laptop && (sp.showToolbar || typingCollapsed);
  const showToolsPills = laptop && !inputFocused && !keyboardVisible;
  const bottomRing = showToolsPills ? renderContextRing("bottom") : null;
  // Left of the tab bar: a small glass capsule carries the context ring and
  // clear-chat (both need a conversation). The ring's popover opens upward from here.
  const toolsPill =
    showToolsPills && messages.length > 0 ? (
      <View pointerEvents="box-none" style={styles.toolsPillWrap}>
        <Glass radius={24} interactive={false} fallbackTint={withAlpha(t.surface2, 0.92)} style={styles.toolsPill}>
          <View style={styles.composerTools}>
            {/* The ring is a native matchContents host: a fixed-size host pins its
                SwiftUI content top-left, so let the slot centre the measured one. */}
            {bottomRing ? <View style={styles.composerToolSlot}>{bottomRing}</View> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear chat"
              hitSlop={8}
              disabled={busy}
              onPress={onClear}
              style={[styles.composerToolBtn, busy && { opacity: 0.4 }]}
            >
              <Trash2 size={18} color={t.textSecondary} />
            </Pressable>
          </View>
        </Glass>
      </View>
    ) : null;
  // Right of the tab bar: AI settings, which the header would otherwise carry. Always
  // present in laptop pose so it stays reachable with an empty chat or a preview open.
  const settingsPill = showToolsPills ? (
    <View pointerEvents="box-none" style={styles.settingsPillWrap}>
      <Glass radius={24} interactive={false} fallbackTint={withAlpha(t.surface2, 0.92)} style={styles.toolsPill}>
        <View style={styles.composerTools}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="AI settings"
            hitSlop={8}
            onPress={() => router.push("/settings/ai")}
            style={styles.composerToolBtn}
          >
            <Settings size={18} color={t.textSecondary} />
          </Pressable>
        </View>
      </Glass>
    </View>
  ) : null;

  return (
    <TabScreen>
      <Stack.Screen
        options={{
          ...sp.screenOptions,
          // Context-window usage ring in the header-left when the active provider
          // reports usage (Apple real, OpenAI real, Rork estimated). Not while a
          // preview is open: its own bar owns the rail, and stacked above the chat
          // the pane's ✕ sits exactly where the ring would, which then swallows taps.
          headerLeft: contextRing && showHeaderTools ? () => contextRing : undefined,
        }}
      />
      {/* While a preview is open its own bar is the rail's: the chat's items
          would stack a second column of buttons beside it (and, folded, keep
          the chat's header up over a chat that isn't showing). */}
      {showHeaderTools ? (
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={ICON_DELETE}
          hidden={messages.length === 0}
          disabled={busy}
          accessibilityLabel="Clear chat"
          // Inline arrow (not a bare toolbarPress(onClear)) so the react-hooks
          // ref lint doesn't flag onClear's transitive ref access during render.
          onPress={() => toolbarPress(onClear)()}
        >
          Clear chat
        </Stack.Toolbar.Button>
        <Stack.Toolbar.Button
          icon={ICON_AI}
          accessibilityLabel="AI settings"
          onPress={toolbarPress(() => router.push("/settings/ai"))}
        >
          AI settings
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      ) : null}
      {/* Every width previews in the pane (not a pushed route): folded it fills
          the window, unfolded it sits beside the chat. Android keeps the route path. */}
      <SidePreviewLayout state={sp} bodyStyle={{ backgroundColor: t.chatBg }} collapsePane={inputFocused}>
      <View style={{ flex: 1 }} onLayout={topHalf.onLayout}>
        {t.chatBgType === "gradient" && t.chatStops.length >= 2 ? (
          <LinearGradient
            colors={t.chatStops as [string, string, ...string[]]}
            start={{ x: 0.1, y: 0.1 }}
            end={{ x: 0.9, y: 0.9 }}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        {t.chatBgType === "pattern" ? <ChatPatternOverlay pattern={t.chatPattern} /> : null}
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
        <KeyboardGestureArea interpolator="ios" style={transcriptArea}>
          <KeyboardChatScrollView
            ref={scrollRef}
            style={styles.scroll}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            // Laptop pose: the keyboard is exactly the flat half below the crease.
            // The transcript either ends at the crease (nothing to lift clear of —
            // lifting pushed the conversation off the top) or, under a stacked
            // preview, lives entirely behind the keyboard (lifting made it poke up
            // over the crease and the composer).
            keyboardLiftBehavior={confined || sp.stacked ? "never" : "whenAtEnd"}
            offset={confined ? topHalf.gap : offset}
            extraContentPadding={confined ? topHalfPadding : extraContentPadding}
            scrollEventThrottle={16}
            onEndVisible={(visible) => { nearBottom.current = visible; }}
            onContentSizeChange={() => {
              // Follow new content only when the user is already near the bottom
              // (e.g. streaming) — never when they've scrolled up to read/expand.
              // No animation while the area is being resized for the fold (it chases
              // a moving layout and slides the transcript out of view).
              if (nearBottom.current) scrollToEndSoon(!(confined || sp.stacked));
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
                {queued.map((q) => (
                  <View key={q.id} style={styles.queuedRow}>
                    <View style={styles.queuedBubble}>
                      <Text style={styles.queuedText}>
                        {q.content || (q.attachments && q.attachments.length > 0 ? "(attachment)" : "")}
                        {q.attachments && q.attachments.length > 0 && q.content ? ` · ${q.attachments.length} attachment${q.attachments.length === 1 ? "" : "s"}` : ""}
                      </Text>
                    </View>
                    <View style={styles.queuedMeta}>
                      <Text style={styles.queuedLabel}>Queued — sends when the current reply finishes</Text>
                      <Pressable onPress={() => removeQueued(q.id)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Remove queued message">
                        <Text style={styles.queuedRemove}>Remove</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
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
          <View style={transcriptArea} pointerEvents="box-none">
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
          </View>
        ) : null}

        <CairnMorphComposer
          ref={composerInputRef}
          input={input}
          onChangeInput={setInput}
          attachments={attachments}
          pendingIds={[]}
          strip={strip}
          plusOut={plusOut}
          onPlusPress={onPlusPress}
          onRemove={removeAttachment}
          busy={busy}
          canSend={canSend}
          onSend={send}
          onInputFocus={() => {
            setInputFocused(true);
            followEnd();
          }}
          onInputBlur={() => setInputFocused(false)}
          hidden={hideComposer}
          leftInset={composerLeftInset}
          closedLift={closedLift}
          onLayoutHeight={(h) => {
            setComposerH(h);
            setComposerHeight(h);
          }}
          allowImages={allowImages}
          queuedCount={queued.length}
        />
        <CairnAttachmentHost
          ref={hostRef}
          strip={strip}
          plusOut={plusOut}
          composerBottom={composerBottom}
          leftInset={composerLeftInset}
          existingCount={attachments.length}
          onAddAttachments={onAddAttachments}
        />
        {toolsPill}
        {settingsPill}
      </View>
      </SidePreviewLayout>
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
    row: { flex: 1, flexDirection: "row", overflow: "hidden" },
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
    // On the tab pill's row, left of it: raised to the pill's vertical centre (the
    // container's bottom edge sits below it) and inset from the display's corner.
    toolsPillWrap: { position: "absolute", left: 16, bottom: 26 },
    settingsPillWrap: { position: "absolute", right: 16, bottom: 26 },
    toolsPill: { height: 48, paddingHorizontal: 10, justifyContent: "center", overflow: "hidden" },
    composerTools: { flexDirection: "row", alignItems: "center", gap: 4, height: 32 },
    composerToolSlot: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
    composerToolBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
    queuedRow: { alignItems: "flex-end", gap: 3, marginBottom: 14 },
    queuedBubble: {
      maxWidth: "90%",
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 14,
      borderTopRightRadius: 4,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: t.border,
    },
    queuedText: { ...typeScale.body, lineHeight: 21, color: t.textSecondary },
    queuedMeta: { flexDirection: "row", alignItems: "center", gap: 12, paddingRight: 4 },
    queuedLabel: { ...typeScale.caption, color: t.textTertiary, flexShrink: 1 },
    queuedRemove: { ...typeScale.caption, color: t.textTertiary, fontWeight: "600" },
  });
}
