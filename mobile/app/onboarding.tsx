/**
 * Onboarding — guides the user to locate their Cairn workspace SQLite file.
 * On iOS, the user picks the workspace.db via the system document picker.
 */
import { useState } from "react";
import { View, Text, Pressable, ActivityIndicator, Alert, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import { openDb } from "../db/client";
import { useStore } from "../store/index";
import * as queries from "../db/queries";

const STORAGE_KEY_DB_PATH = "cairn:mobile:dbPath";
const STORAGE_KEY_WORKSPACE_ID = "cairn:mobile:workspaceId";

export default function Onboarding() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const setDbPath = useStore((s) => s.setDbPath);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const loadWorkspaces = useStore((s) => s.loadWorkspaces);

  async function pickDatabase() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: false,
      });

      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      const path = asset.uri.replace("file://", "");

      setLoading(true);

      await openDb(path);
      await loadWorkspaces();

      const workspaces = await queries.getWorkspaces();

      if (workspaces.length === 0) {
        Alert.alert(
          "No workspaces found",
          "The selected file does not appear to be a valid Cairn workspace database."
        );
        setLoading(false);
        return;
      }

      // Auto-select the first workspace (most Cairn users have one)
      const workspace = workspaces[0];

      await AsyncStorage.setItem(STORAGE_KEY_DB_PATH, path);
      await AsyncStorage.setItem(STORAGE_KEY_WORKSPACE_ID, workspace.id);

      setDbPath(path);
      setActiveWorkspace(workspace.id);

      router.replace("/(tabs)");
    } catch (e) {
      Alert.alert("Error", String(e));
      setLoading(false);
    }
  }

  return (
    <ScrollView
      className="flex-1 bg-zinc-950"
      contentContainerClassName="flex-1 items-center justify-center px-8 py-12"
    >
      {/* Logo area */}
      <View className="mb-10 items-center">
        <View className="w-16 h-16 rounded-2xl bg-indigo-600 items-center justify-center mb-4">
          <Text className="text-white text-3xl font-bold">C</Text>
        </View>
        <Text className="text-white text-3xl font-bold tracking-tight">Cairn</Text>
        <Text className="text-zinc-400 text-base mt-1">Mobile Companion</Text>
      </View>

      {/* Steps */}
      <View className="w-full mb-10 gap-4">
        {[
          {
            step: "1",
            title: "Place your workspace in iCloud",
            body: "On your Mac, move (or create) your Cairn workspace folder inside iCloud Drive so it syncs to your iPhone.",
          },
          {
            step: "2",
            title: "Open workspace.db",
            body: 'Tap the button below and navigate to your Cairn workspace folder. Select the "workspace.db" file.',
          },
          {
            step: "3",
            title: "Stay in sync",
            body: "Cairn mobile reads and writes the same SQLite file as the desktop app. Changes sync automatically via iCloud.",
          },
        ].map(({ step, title, body }) => (
          <View key={step} className="flex-row gap-4 bg-zinc-900 rounded-xl p-4">
            <View className="w-7 h-7 rounded-full bg-indigo-600 items-center justify-center shrink-0 mt-0.5">
              <Text className="text-white text-xs font-bold">{step}</Text>
            </View>
            <View className="flex-1">
              <Text className="text-white text-sm font-semibold mb-1">{title}</Text>
              <Text className="text-zinc-400 text-sm leading-5">{body}</Text>
            </View>
          </View>
        ))}
      </View>

      {/* CTA */}
      <Pressable
        onPress={pickDatabase}
        disabled={loading}
        className="w-full bg-indigo-600 rounded-xl py-4 items-center active:opacity-80"
      >
        {loading ? (
          <ActivityIndicator color="white" />
        ) : (
          <Text className="text-white font-semibold text-base">Select workspace.db</Text>
        )}
      </Pressable>

      <Text className="text-zinc-600 text-xs text-center mt-6 leading-5">
        Cairn Mobile only reads and writes the SQLite database. Your notes and markdown files are
        never modified without your action.
      </Text>
    </ScrollView>
  );
}
