import { View, Text, Pressable, FlatList, RefreshControl } from "react-native";
import { useRouter } from "expo-router";
import { useState, useCallback, useEffect } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { Plus, MessageCircle } from "lucide-react-native";
import { formatDistanceToNow } from "date-fns";
import { useStore } from "../../store/index";

export default function ChatTab() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  const workspaceId = useStore((s) => s.activeWorkspaceId);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const threads = useStore((s) => s.threads);
  const loadThreads = useStore((s) => s.loadThreads);
  const createThread = useStore((s) => s.createThread);

  useEffect(() => { if (workspaceId) loadThreads(workspaceId, activeProjectId ?? undefined); }, [workspaceId, activeProjectId]);

  const onRefresh = useCallback(async () => {
    if (!workspaceId) return;
    setRefreshing(true);
    await loadThreads(workspaceId, activeProjectId ?? undefined);
    setRefreshing(false);
  }, [workspaceId, activeProjectId]);

  const onNew = async () => {
    if (!workspaceId) return;
    const t = await createThread(workspaceId, activeProjectId ?? undefined);
    router.push(`/chat/${t.id}`);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0d0d0d" }} edges={["top"]}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: "#e8e4dc", fontSize: 22, fontWeight: "700", letterSpacing: -0.3 }}>AI Chat</Text>
          <Text style={{ color: "#66635f", fontSize: 12, marginTop: 2 }}>{threads.length} thread{threads.length !== 1 ? "s" : ""}</Text>
        </View>
        <Pressable
          onPress={onNew}
          style={({ pressed }) => ({ width: 34, height: 34, borderRadius: 17, backgroundColor: "#7c6af7", alignItems: "center", justifyContent: "center", opacity: pressed ? 0.8 : 1 })}
        >
          <Plus color="#fff" size={18} />
        </Pressable>
      </View>

      <FlatList
        data={threads}
        keyExtractor={(t) => t.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 6 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#7c6af7" />}
        ListEmptyComponent={
          <View style={{ alignItems: "center", paddingVertical: 60, gap: 12 }}>
            <MessageCircle color="#2a2a2a" size={36} />
            <Text style={{ color: "#66635f", fontSize: 13 }}>No conversations yet</Text>
            <Pressable
              onPress={onNew}
              style={({ pressed }) => ({ paddingHorizontal: 20, paddingVertical: 10, backgroundColor: "#7c6af7", borderRadius: 10, opacity: pressed ? 0.8 : 1 })}
            >
              <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>Start a conversation</Text>
            </Pressable>
          </View>
        }
        renderItem={({ item: t }) => (
          <Pressable
            onPress={() => router.push(`/chat/${t.id}`)}
            style={({ pressed }) => ({
              backgroundColor: pressed ? "#1a1a1a" : "#141414",
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "#2a2a2a",
              padding: 14,
            })}
          >
            <Text numberOfLines={1} style={{ color: "#e8e4dc", fontSize: 13, fontWeight: "500", marginBottom: 3 }}>
              {t.title || "Untitled conversation"}
            </Text>
            <Text style={{ color: "#66635f", fontSize: 11 }}>
              {formatDistanceToNow(new Date(t.updatedAt), { addSuffix: true })}
            </Text>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}
