/**
 * Chat tab — thread list for AI conversations.
 */
import { View, Text, Pressable, FlatList, RefreshControl } from "react-native";
import { useRouter } from "expo-router";
import { useState, useCallback, useEffect } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { Plus, MessageCircle } from "lucide-react-native";
import { useStore } from "../../store/index";
import { formatDistanceToNow } from "date-fns";

export default function ChatTab() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  const workspaceId = useStore((s) => s.activeWorkspaceId);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const threads = useStore((s) => s.threads);
  const loadThreads = useStore((s) => s.loadThreads);
  const createThread = useStore((s) => s.createThread);

  useEffect(() => {
    if (workspaceId) loadThreads(workspaceId, activeProjectId ?? undefined);
  }, [workspaceId, activeProjectId]);

  const onRefresh = useCallback(async () => {
    if (!workspaceId) return;
    setRefreshing(true);
    await loadThreads(workspaceId, activeProjectId ?? undefined);
    setRefreshing(false);
  }, [workspaceId, activeProjectId]);

  const onNewThread = async () => {
    if (!workspaceId) return;
    const thread = await createThread(workspaceId, activeProjectId ?? undefined);
    router.push(`/chat/${thread.id}`);
  };

  return (
    <SafeAreaView className="flex-1 bg-zinc-950" edges={["top"]}>
      {/* Header */}
      <View className="flex-row items-center justify-between px-5 pt-4 pb-3">
        <View>
          <Text className="text-white text-2xl font-bold tracking-tight">AI Chat</Text>
          <Text className="text-zinc-500 text-sm mt-0.5">{threads.length} thread{threads.length !== 1 ? "s" : ""}</Text>
        </View>
        <Pressable
          onPress={onNewThread}
          className="w-9 h-9 rounded-full bg-indigo-600 items-center justify-center active:opacity-80"
        >
          <Plus color="white" size={18} />
        </Pressable>
      </View>

      <FlatList
        data={threads}
        keyExtractor={(t) => t.id}
        contentContainerClassName="px-5 pb-8 gap-2"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#6366f1" />
        }
        ListEmptyComponent={
          <View className="items-center py-16">
            <MessageCircle color="#3f3f46" size={40} />
            <Text className="text-zinc-600 text-base mt-3">No conversations yet.</Text>
            <Pressable
              onPress={onNewThread}
              className="mt-4 px-5 py-2.5 bg-indigo-600 rounded-xl active:opacity-80"
            >
              <Text className="text-white font-semibold text-sm">Start a conversation</Text>
            </Pressable>
          </View>
        }
        renderItem={({ item: thread }) => (
          <Pressable
            onPress={() => router.push(`/chat/${thread.id}`)}
            className="bg-zinc-900 rounded-xl p-4 active:opacity-80"
          >
            <Text className="text-white font-medium text-sm" numberOfLines={1}>
              {thread.title || "Untitled conversation"}
            </Text>
            <Text className="text-zinc-500 text-xs mt-1">
              {formatDistanceToNow(new Date(thread.updatedAt), { addSuffix: true })}
            </Text>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}
