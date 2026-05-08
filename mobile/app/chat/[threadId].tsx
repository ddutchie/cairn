import { View, Text, Pressable, FlatList, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft, Send } from "lucide-react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useStore } from "../../store/index";
import type { ChatMessage } from "../../../src/types/index";
import { customAlphabet } from "nanoid/non-secure";
import * as queries from "../../db/queries";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 12);
const now = () => new Date().toISOString();
const AI_CONFIG_KEY = "cairn:mobile:aiConfig";

interface AIConfig { provider: "openai" | "anthropic" | "groq"; apiKey: string; model: string; }

export default function ChatThread() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const router = useRouter();
  const listRef = useRef<FlatList>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);

  const threads = useStore((s) => s.threads);
  const messages = useStore((s) => s.messages);
  const activeThread = useStore((s) => s.activeThread);
  const selectThread = useStore((s) => s.selectThread);
  const addMessage = useStore((s) => s.addMessage);
  const updateLast = useStore((s) => s.updateLastAssistantMessage);

  const thread = threads.find((t) => t.id === threadId) ?? activeThread;

  useEffect(() => { if (thread && activeThread?.id !== thread.id) selectThread(thread); }, [threadId]);
  useEffect(() => { if (messages.length > 0) setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80); }, [messages.length]);

  async function send() {
    if (!input.trim() || streaming || !thread) return;
    const raw = await AsyncStorage.getItem(AI_CONFIG_KEY);
    if (!raw) { alert("Set your AI provider in Settings first."); return; }
    const cfg: AIConfig = JSON.parse(raw);
    if (!cfg.apiKey) { alert("Add an API key in Settings."); return; }

    const userMsg: ChatMessage = { id: nanoid(), threadId: thread.id, role: "user", content: input.trim(), createdAt: now() };
    await addMessage(userMsg);
    setInput("");
    setStreaming(true);

    const assistantMsg: ChatMessage = { id: nanoid(), threadId: thread.id, role: "assistant", content: "", createdAt: now() };
    useStore.getState().addMessage(assistantMsg);

    try {
      const history = [...messages, userMsg].map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      const isAnthropic = cfg.provider === "anthropic";
      const endpoint = isAnthropic ? "https://api.anthropic.com/v1/messages" : cfg.provider === "groq" ? "https://api.groq.com/openai/v1/chat/completions" : "https://api.openai.com/v1/chat/completions";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let body: string;

      if (isAnthropic) {
        headers["x-api-key"] = cfg.apiKey;
        headers["anthropic-version"] = "2023-06-01";
        body = JSON.stringify({ model: cfg.model, max_tokens: 2048, stream: true, messages: history });
      } else {
        headers["Authorization"] = `Bearer ${cfg.apiKey}`;
        body = JSON.stringify({ model: cfg.model, stream: true, messages: [{ role: "system", content: "You are a helpful assistant for the Cairn project management app." }, ...history] });
      }

      const res = await fetch(endpoint, { method: "POST", headers, body });
      if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      const dec = new TextDecoder();
      let acc = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value, { stream: true }).split("\n").filter((l) => l.startsWith("data: "))) {
          const d = line.slice(6).trim();
          if (d === "[DONE]") continue;
          try {
            const j = JSON.parse(d);
            const t = j.choices?.[0]?.delta?.content ?? j.delta?.text ?? j.delta?.content;
            if (t) { acc += t; updateLast(acc); }
          } catch {}
        }
      }

      await queries.createMessage({ ...assistantMsg, content: acc });
      updateLast(acc);
    } catch (e) {
      updateLast(`Error: ${String(e)}`);
    } finally {
      setStreaming(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0d0d0d" }} edges={["top"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        {/* Header */}
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: "#1f1f1f" }}>
          <Pressable onPress={() => router.back()} hitSlop={8}><ArrowLeft color="#66635f" size={20} /></Pressable>
          <Text numberOfLines={1} style={{ flex: 1, color: "#e8e4dc", fontSize: 15, fontWeight: "600" }}>
            {thread?.title || "AI Chat"}
          </Text>
        </View>

        {/* Messages */}
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 14, gap: 10 }}
          ListEmptyComponent={
            <View style={{ alignItems: "center", paddingVertical: 60 }}>
              <Text style={{ color: "#3a3835", fontSize: 13 }}>Start a conversation</Text>
            </View>
          }
          renderItem={({ item: m }) => <Bubble message={m} />}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        />

        {/* Input */}
        <View style={{ flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#1f1f1f", gap: 10 }}>
          <TextInput
            style={{ flex: 1, backgroundColor: "#141414", borderWidth: 1, borderColor: "#2a2a2a", borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, color: "#e8e4dc", fontSize: 14, maxHeight: 100 }}
            placeholder="Message…"
            placeholderTextColor="#3a3835"
            value={input}
            onChangeText={setInput}
            multiline
            maxLength={4000}
          />
          <Pressable
            onPress={send}
            disabled={!input.trim() || streaming}
            style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: input.trim() && !streaming ? "#7c6af7" : "#1a1a1a", alignItems: "center", justifyContent: "center" }}
          >
            {streaming
              ? <ActivityIndicator color="#7c6af7" size="small" />
              : <Send color={input.trim() ? "#fff" : "#3a3835"} size={16} />
            }
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Bubble({ message: m }: { message: ChatMessage }) {
  const isUser = m.role === "user";
  return (
    <View style={{ flexDirection: "row", justifyContent: isUser ? "flex-end" : "flex-start" }}>
      <View style={{
        maxWidth: "84%",
        paddingHorizontal: 13, paddingVertical: 10,
        borderRadius: 16,
        borderBottomRightRadius: isUser ? 4 : 16,
        borderBottomLeftRadius: isUser ? 16 : 4,
        backgroundColor: isUser ? "#7c6af7" : "#141414",
        borderWidth: isUser ? 0 : 1,
        borderColor: "#2a2a2a",
      }}>
        <Text style={{ color: isUser ? "#fff" : "#e8e4dc", fontSize: 14, lineHeight: 20 }}>
          {m.content || "▋"}
        </Text>
      </View>
    </View>
  );
}
