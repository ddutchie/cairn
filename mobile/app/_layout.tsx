/**
 * Root layout — initialises DB, hydrates store, then renders navigation.
 */
import "../global.css";
import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { View, Text, ActivityIndicator } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { openDb } from "../db/client";
import { useStore } from "../store/index";

const STORAGE_KEY_DB_PATH = "cairn:mobile:dbPath";
const STORAGE_KEY_WORKSPACE_ID = "cairn:mobile:workspaceId";

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setDbPath = useStore((s) => s.setDbPath);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const loadWorkspaces = useStore((s) => s.loadWorkspaces);

  useEffect(() => {
    (async () => {
      try {
        const dbRaw = await AsyncStorage.getItem(STORAGE_KEY_DB_PATH);
        const workspaceId = await AsyncStorage.getItem(STORAGE_KEY_WORKSPACE_ID);

        if (dbRaw) {
          // Stored as JSON { filename, directory } since the new expo-sqlite API
          // takes filename + optional directory separately
          const { filename, directory } = JSON.parse(dbRaw) as {
            filename: string;
            directory?: string;
          };
          setDbPath(filename);
          await openDb(filename, directory);
          await loadWorkspaces();

          if (workspaceId) {
            setActiveWorkspace(workspaceId);
          }
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setReady(true);
      }
    })();
  }, []);

  if (!ready) {
    return (
      <SafeAreaProvider>
        <View className="flex-1 items-center justify-center bg-zinc-950">
          <ActivityIndicator color="#6366f1" size="large" />
        </View>
      </SafeAreaProvider>
    );
  }

  if (error) {
    return (
      <SafeAreaProvider>
        <View className="flex-1 items-center justify-center bg-zinc-950 px-6">
          <Text className="text-red-400 text-center">{error}</Text>
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="project/[id]" />
        <Stack.Screen name="note/[id]" />
        <Stack.Screen name="chat/[threadId]" />
      </Stack>
    </SafeAreaProvider>
  );
}
