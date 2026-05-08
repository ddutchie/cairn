/**
 * Chat thread — streams AI responses using the Vercel AI SDK.
 * API key and provider are read from AsyncStorage (set in Settings).
 */
import {
  View, Text, Pressable, FlatList, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator
} from "react-native";
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

interface AIConfig {
  provider: "openai" | "anthropic" | "groq";
  apiKey: string;
  model: string;
}

const PROVIDER_BASE_URLS: Record<AIConfig["provider"], string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  groq: "https://api.groq.com/openai/v1",
};

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
  const updateLastAssistantMessage = useStore((s) => s.updateLastAssistantMessage);

  const thread = threads.find((t) => t.id === threadId) ?? activeThread;

  useEffect(() => {
    if (!thread) return;
    if (activeThread?.id !== thread.id) selectThread(thread);
  }, [threadId]);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length]);

  async function sendMessage() {
    if (!input.trim() || streaming || !thread) return;

    const configRaw = await AsyncStorage.getItem(AI_CONFIG_KEY);
    if (!configRaw) {
      alert("Set your AI provider and API key in Settings first.");
      return;
    }
    const config: AIConfig = JSON.parse(configRaw);
    if (!config.apiKey) {
      alert("Set your AI API key in Settings first.");
      return;
    }

    const userMessage: ChatMessage = {
      id: nanoid(),
      threadId: thread.id,
      role: "user",
      content: input.trim(),
      createdAt: now(),
    };

    await addMessage(userMessage);
    setInput("");
    setStreaming(true);

    // Placeholder for streaming assistant message
    const assistantMessage: ChatMessage = {
      id: nanoid(),
      threadId: thread.id,
      role: "assistant",
      content: "",
      createdAt: now(),
    };

    // Optimistically add empty assistant message
    useStore.getState().addMessage(assistantMessage);

    try {
      // Build conversation history for context
      const history = [...messages, userMessage].map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // Choose the correct endpoint + headers based on provider
      const isAnthropic = config.provider === "anthropic";
      const endpoint = isAnthropic
        ? "https://api.anthropic.com/v1/messages"
        : `${PROVIDER_BASE_URLS[config.provider]}/chat/completions`;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      let body: string;

      if (isAnthropic) {
        headers["x-api-key"] = config.apiKey;
        headers["anthropic-version"] = "2023-06-01";
        body = JSON.stringify({
          model: config.model,
          max_tokens: 2048,
          stream: true,
          messages: history,
        });
      } else {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
        body = JSON.stringify({
          model: config.model,
          stream: true,
          messages: [
            { role: "system", content: "You are a helpful assistant for the Cairn project management app." },
            ...history,
          ],
        });
      }

      const response = await fetch(endpoint, { method: "POST", headers, body });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`API error ${response.status}: ${err}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter((l) => l.trim());

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const json = JSON.parse(data);

            // OpenAI / Groq format
            const delta = json.choices?.[0]?.delta?.content;
            // Anthropic format
            const anthropicDelta = json.delta?.text ?? json.delta?.content;

            const text = delta ?? anthropicDelta;
            if (text) {
              accumulated += text;
              updateLastAssistantMessage(accumulated);
            }
          } catch {
            // skip non-JSON lines
          }
        }
      }

      // Persist the final assistant message
      await queries.createMessage({
        ...assistantMessage,
        content: accumulated,
      });

      // Update the in-memory message with final content
      updateLastAssistantMessage(accumulated);
    } catch (e) {
      updateLastAssistantMessage(`Error: ${String(e)}`);
    } finally {
      setStreaming(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-zinc-950" edges={["top"]}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        {/* Header */}
        <View className="flex-row items-center gap-3 px-4 pt-2 pb-3 border-b border-zinc-800">
          <Pressable onPress={() => router.back()} className="active:opacity-70">
            <ArrowLeft color="#a1a1aa" size={22} />
          </Pressable>
          <Text className="flex-1 text-white font-semibold text-base" numberOfLines={1}>
            {thread?.title || "AI Chat"}
          </Text>
        </View>

        {/* Messages */}
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          className="flex-1"
          contentContainerClassName="px-4 py-4 gap-3"
          ListEmptyComponent={
            <View className="items-center py-12">
              <Text className="text-zinc-600 text-sm">Start a conversation</Text>
            </View>
          }
          renderItem={({ item: msg }) => <MessageBubble message={msg} />}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        />

        {/* Input */}
        <View className="flex-row items-end gap-2 px-4 py-3 border-t border-zinc-800">
          <TextInput
            className="flex-1 bg-zinc-900 rounded-2xl px-4 py-3 text-white text-sm"
            placeholder="Message…"
            placeholderTextColor="#52525b"
            value={input}
            onChangeText={setInput}
            multiline
            maxLength={4000}
          />
          <Pressable
            onPress={sendMessage}
            disabled={!input.trim() || streaming}
            className={`w-10 h-10 rounded-full items-center justify-center ${
              input.trim() && !streaming ? "bg-indigo-600" : "bg-zinc-800"
            } active:opacity-80`}
          >
            {streaming ? (
              <ActivityIndicator color="#6366f1" size="small" />
            ) : (
              <Send color={input.trim() ? "white" : "#52525b"} size={18} />
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <View className={`flex-row ${isUser ? "justify-end" : "justify-start"}`}>
      <View
        className={`max-w-[85%] rounded-2xl px-4 py-3 ${
          isUser ? "bg-indigo-600 rounded-tr-sm" : "bg-zinc-800 rounded-tl-sm"
        }`}
      >
        <Text className="text-white text-sm leading-5">
          {message.content || (message.role === "assistant" ? "▋" : "")}
        </Text>
      </View>
    </View>
  );
}
