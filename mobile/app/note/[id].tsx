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
  const [draft, setDraft] = useState("");

  const activeNote = useStore((s) => s.activeNote);
  const loadNote = useStore((s) => s.loadNote);
  const updateNote = useStore((s) => s.updateNote);
  const clearActiveNote = useStore((s) => s.clearActiveNote);

  useEffect(() => { if (id) loadNote(id); return () => clearActiveNote(); }, [id]);
  useEffect(() => { if (activeNote) setDraft(activeNote.content); }, [activeNote?.id]);

  async function save() {
    if (!activeNote) return;
    await updateNote(activeNote.id, { content: draft, contentText: draft.replace(/[#*_`>\[\]]/g, "").trim() });
    setEditing(false);
  }

  if (!activeNote) return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0d0d0d", alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: "#66635f" }}>Loading…</Text>
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0d0d0d" }} edges={["top"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        {/* Header */}
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: "#1f1f1f" }}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <ArrowLeft color="#66635f" size={20} />
          </Pressable>
          <Text numberOfLines={1} style={{ flex: 1, color: "#e8e4dc", fontSize: 15, fontWeight: "600", letterSpacing: -0.2 }}>
            {activeNote.title}
          </Text>
          {editing ? (
            <View style={{ flexDirection: "row", gap: 14 }}>
              <Pressable onPress={() => { setEditing(false); setDraft(activeNote.content); }} hitSlop={8}>
                <X color="#66635f" size={18} />
              </Pressable>
              <Pressable onPress={save} hitSlop={8}>
                <Check color="#7c6af7" size={18} />
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => setEditing(true)} hitSlop={8}>
              <Edit2 color="#66635f" size={18} />
            </Pressable>
          )}
        </View>

        {editing ? (
          <TextInput
            style={{ flex: 1, paddingHorizontal: 20, paddingTop: 16, color: "#e8e4dc", fontSize: 14, lineHeight: 22, fontFamily: "monospace" }}
            value={draft}
            onChangeText={setDraft}
            multiline
            autoFocus
            textAlignVertical="top"
          />
        ) : (
          <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 }}>
            <Markdown
              style={{
                body:        { color: "#e8e4dc", fontSize: 14, lineHeight: 22 },
                heading1:    { color: "#f0ece4", fontSize: 20, fontWeight: "700", marginBottom: 10, marginTop: 4, letterSpacing: -0.3 },
                heading2:    { color: "#e8e4dc", fontSize: 17, fontWeight: "600", marginBottom: 8, marginTop: 18 },
                heading3:    { color: "#e8e4dc", fontSize: 15, fontWeight: "600", marginBottom: 6, marginTop: 14 },
                paragraph:   { marginBottom: 12 },
                code_inline: { backgroundColor: "#1a1a1a", color: "#9281ff", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12, borderRadius: 4 },
                fence:       { backgroundColor: "#141414", borderRadius: 8, padding: 14, marginBottom: 12 },
                code_block:  { color: "#9281ff", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12 },
                blockquote:  { borderLeftColor: "#2a2a2a", borderLeftWidth: 3, paddingLeft: 12, marginBottom: 12 },
                link:        { color: "#7c6af7" },
                hr:          { backgroundColor: "#2a2a2a", height: 1, marginVertical: 16 },
                table:       { borderWidth: 1, borderColor: "#2a2a2a", borderRadius: 6 },
                th:          { backgroundColor: "#141414", color: "#9e9a94", fontSize: 12, fontWeight: "600", padding: 8 },
                td:          { color: "#e8e4dc", fontSize: 13, padding: 8, borderTopWidth: 1, borderTopColor: "#2a2a2a" },
                bullet_list: { marginBottom: 10 },
                list_item:   { color: "#e8e4dc", marginBottom: 4 },
              }}
            >
              {activeNote.content || "_No content yet. Tap the edit button to add some._"}
            </Markdown>
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
