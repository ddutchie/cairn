/**
 * Note detail — renders markdown content and allows basic editing.
 */
import { View, Text, Pressable, ScrollView, TextInput, KeyboardAvoidingView, Platform } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft, Edit2, Check, X } from "lucide-react-native";
import Markdown from "react-native-markdown-display";
import { useStore } from "../../store/index";

export default function NoteDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");

  const activeNote = useStore((s) => s.activeNote);
  const loadNote = useStore((s) => s.loadNote);
  const updateNote = useStore((s) => s.updateNote);
  const clearActiveNote = useStore((s) => s.clearActiveNote);

  useEffect(() => {
    if (id) loadNote(id);
    return () => clearActiveNote();
  }, [id]);

  useEffect(() => {
    if (activeNote) setEditContent(activeNote.content);
  }, [activeNote?.id]);

  async function saveEdit() {
    if (!activeNote) return;
    const plain = editContent.replace(/[#*_`>\[\]]/g, "").trim();
    await updateNote(activeNote.id, { content: editContent, contentText: plain });
    setEditing(false);
  }

  if (!activeNote) {
    return (
      <SafeAreaView className="flex-1 bg-zinc-950 items-center justify-center">
        <Text className="text-zinc-500">Loading…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-zinc-950" edges={["top"]}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {/* Header */}
        <View className="flex-row items-center gap-3 px-4 pt-2 pb-3">
          <Pressable onPress={() => router.back()} className="active:opacity-70">
            <ArrowLeft color="#a1a1aa" size={22} />
          </Pressable>
          <Text className="flex-1 text-white font-bold text-base" numberOfLines={1}>
            {activeNote.title}
          </Text>
          {editing ? (
            <View className="flex-row gap-3">
              <Pressable onPress={() => { setEditing(false); setEditContent(activeNote.content); }} className="active:opacity-70">
                <X color="#71717a" size={20} />
              </Pressable>
              <Pressable onPress={saveEdit} className="active:opacity-70">
                <Check color="#6366f1" size={20} />
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => setEditing(true)} className="active:opacity-70">
              <Edit2 color="#71717a" size={20} />
            </Pressable>
          )}
        </View>

        {editing ? (
          <TextInput
            className="flex-1 px-5 text-white text-sm leading-6 font-mono"
            value={editContent}
            onChangeText={setEditContent}
            multiline
            autoFocus
            textAlignVertical="top"
          />
        ) : (
          <ScrollView
            className="flex-1"
            contentContainerClassName="px-5 pb-12"
          >
            <Markdown
              style={{
                body: { color: "#e4e4e7", fontSize: 14, lineHeight: 22 },
                heading1: { color: "#ffffff", fontSize: 20, fontWeight: "700", marginBottom: 8 },
                heading2: { color: "#f4f4f5", fontSize: 17, fontWeight: "600", marginBottom: 6 },
                heading3: { color: "#f4f4f5", fontSize: 15, fontWeight: "600", marginBottom: 4 },
                code_inline: {
                  backgroundColor: "#27272a",
                  color: "#a5b4fc",
                  fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                  fontSize: 13,
                },
                fence: {
                  backgroundColor: "#18181b",
                  borderRadius: 8,
                  padding: 12,
                },
                code_block: {
                  backgroundColor: "#18181b",
                  color: "#a5b4fc",
                  fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                  fontSize: 13,
                },
                blockquote: {
                  borderLeftColor: "#6366f1",
                  borderLeftWidth: 3,
                  paddingLeft: 12,
                  color: "#a1a1aa",
                },
                link: { color: "#818cf8" },
                bullet_list: { marginBottom: 8 },
                ordered_list: { marginBottom: 8 },
                hr: { backgroundColor: "#27272a", height: 1 },
              }}
            >
              {activeNote.content || "_No content_"}
            </Markdown>
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
