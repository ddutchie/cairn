import { useCallback, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Wrench, Send } from "lucide-react-native";
import { Screen } from "@/components/Screen";
import { MarkdownView } from "@/components/MarkdownView";
import { useTheme, type Theme } from "@/theme";
import { runAgent, type AgentEvent } from "@/chat/agent";
import type { ChatMsg } from "@/chat/rork-client";

interface UiMessage {
  role: "user" | "assistant";
  content: string;
  tools?: { tool: string; ok: boolean }[];
}

export default function ChatScreen() {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const nextMessages: UiMessage[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setBusy(true);

    // Build history for the agent (user/assistant only).
    const history: ChatMsg[] = nextMessages.map((m) => ({ role: m.role, content: m.content }));
    const toolTrail: { tool: string; ok: boolean }[] = [];

    try {
      const onEvent = (e: AgentEvent) => {
        if (e.type === "tool" && e.tool) {
          const ok = !(e.result && typeof e.result === "object" && "error" in (e.result as object));
          toolTrail.push({ tool: e.tool, ok });
          setMessages((prev) => {
            // Show a live "thinking" assistant bubble with the tool trail.
            const withoutPending = prev.filter((m) => m.role !== "assistant" || m.content !== "…");
            return [...withoutPending, { role: "assistant", content: "…", tools: [...toolTrail] }];
          });
        }
      };
      const answer = await runAgent(history, onEvent);
      setMessages((prev) => {
        const cleaned = prev.filter((m) => !(m.role === "assistant" && m.content === "…"));
        return [...cleaned, { role: "assistant", content: answer, tools: toolTrail.length ? toolTrail : undefined }];
      });
    } catch (e) {
      setMessages((prev) => {
        const cleaned = prev.filter((m) => !(m.role === "assistant" && m.content === "…"));
        const msg = e instanceof Error && /network|fetch|failed/i.test(e.message)
          ? "Chat needs a connection. Reconnect and try again."
          : `Error: ${e instanceof Error ? e.message : String(e)}`;
        return [...cleaned, { role: "assistant", content: msg }];
      });
    } finally {
      setBusy(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [input, busy, messages]);

  return (
    <Screen title="Chat">
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={90}
      >
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={styles.list}
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

        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Message Cairn…"
            placeholderTextColor={t.textTertiary}
            multiline
            editable={!busy}
          />
          <Pressable style={[styles.sendBtn, (!input.trim() || busy) && styles.sendBtnDisabled]} onPress={send} disabled={!input.trim() || busy}>
            {busy ? <ActivityIndicator color={t.accentFg} size="small" /> : <Send size={16} color={t.accentFg} />}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Bubble({ m, t, styles }: { m: UiMessage; t: Theme; styles: ReturnType<typeof makeStyles> }) {
  const isUser = m.role === "user";
  return (
    <View style={[styles.bubbleWrap, isUser ? styles.userWrap : styles.aiWrap]}>
      {m.tools && m.tools.length > 0 && (
        <View style={styles.toolTrail}>
          {m.tools.map((tt, i) => (
            <View key={i} style={styles.toolChip}>
              <Wrench size={10} color={tt.ok ? t.success : t.danger} />
              <Text style={styles.toolChipText}>{tt.tool}</Text>
            </View>
          ))}
        </View>
      )}
      {m.content === "…" ? (
        <ActivityIndicator color={t.textTertiary} size="small" />
      ) : isUser ? (
        <Text style={styles.userText}>{m.content}</Text>
      ) : (
        <MarkdownView content={m.content} />
      )}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    list: { padding: 14, paddingBottom: 20 },
    empty: { alignItems: "center", justifyContent: "center", paddingVertical: 60, paddingHorizontal: 24 },
    emptyTitle: { fontSize: 18, fontWeight: "700", color: t.textSecondary },
    emptyHint: { fontSize: 13, color: t.textTertiary, textAlign: "center", marginTop: 8, lineHeight: 19 },
    bubbleWrap: { marginBottom: 12, maxWidth: "88%", borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 },
    userWrap: { alignSelf: "flex-end", backgroundColor: t.accent },
    aiWrap: { alignSelf: "flex-start", backgroundColor: t.surface, borderWidth: 1, borderColor: t.border },
    userText: { color: t.accentFg, fontSize: 15, lineHeight: 21 },
    toolTrail: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
    toolChip: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: t.surface2, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
    toolChipText: { fontSize: 11, color: t.textSecondary, fontFamily: "Menlo" },
    composer: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
      padding: 10,
      borderTopWidth: 1,
      borderTopColor: t.border,
      backgroundColor: t.surface,
    },
    input: {
      flex: 1,
      maxHeight: 120,
      backgroundColor: t.surface2,
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingVertical: 10,
      color: t.textPrimary,
      fontSize: 15,
    },
    sendBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: t.accent, alignItems: "center", justifyContent: "center" },
    sendBtnDisabled: { opacity: 0.4 },
  });
}
