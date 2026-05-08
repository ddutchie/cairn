/**
 * Onboarding — two paths:
 *   1. Pick an existing workspace.db (iCloud sync with desktop)
 *   2. Create a fresh demo workspace (simulator / first run)
 */
import { useState } from "react";
import { View, Text, Pressable, ActivityIndicator, Alert, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import { openDb } from "../db/client";
import { useStore } from "../store/index";
import * as queries from "../db/queries";
import { createFreshWorkspace, DEMO_DB_FILENAME } from "../db/seed";

const STORAGE_KEY_DB_PATH = "cairn:mobile:dbPath";
const STORAGE_KEY_WORKSPACE_ID = "cairn:mobile:workspaceId";

export default function Onboarding() {
  const router = useRouter();
  const [loading, setLoading] = useState<"pick" | "demo" | null>(null);

  const setDbPath = useStore((s) => s.setDbPath);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const loadWorkspaces = useStore((s) => s.loadWorkspaces);

  // ── Pick existing workspace.db ──────────────────────────────────────────
  async function pickDatabase() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: false,
      });

      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      // Split into directory + filename for the new expo-sqlite API
      const fullPath = asset.uri.replace("file://", "");
      const lastSlash = fullPath.lastIndexOf("/");
      const directory = fullPath.slice(0, lastSlash + 1);
      const filename = fullPath.slice(lastSlash + 1);

      setLoading("pick");

      await openDb(filename, directory);
      await loadWorkspaces();

      const workspaces = await queries.getWorkspaces();

      if (workspaces.length === 0) {
        Alert.alert(
          "No workspaces found",
          "The selected file does not appear to be a valid Cairn workspace database."
        );
        setLoading(null);
        return;
      }

      const workspace = workspaces[0];

      // Store filename + directory separately for re-opening on next launch
      await AsyncStorage.setItem(STORAGE_KEY_DB_PATH, JSON.stringify({ filename, directory }));
      await AsyncStorage.setItem(STORAGE_KEY_WORKSPACE_ID, workspace.id);

      setDbPath(fullPath);
      setActiveWorkspace(workspace.id);

      router.replace("/(tabs)");
    } catch (e) {
      Alert.alert("Error", String(e));
      setLoading(null);
    }
  }

  // ── Create fresh demo workspace ─────────────────────────────────────────
  async function createDemo() {
    try {
      setLoading("demo");

      const { workspaceId } = await createFreshWorkspace();

      await loadWorkspaces();

      await AsyncStorage.setItem(
        STORAGE_KEY_DB_PATH,
        JSON.stringify({ filename: DEMO_DB_FILENAME, directory: undefined })
      );
      await AsyncStorage.setItem(STORAGE_KEY_WORKSPACE_ID, workspaceId);

      setDbPath(DEMO_DB_FILENAME);
      setActiveWorkspace(workspaceId);

      router.replace("/(tabs)");
    } catch (e) {
      Alert.alert("Error creating workspace", String(e));
      setLoading(null);
    }
  }

  return (
    <ScrollView
      className="flex-1 bg-zinc-950"
      contentContainerClassName="flex-grow items-center justify-center px-8 py-16"
    >
      {/* Logo */}
      <View className="mb-10 items-center">
        <View className="w-16 h-16 rounded-2xl bg-indigo-600 items-center justify-center mb-4">
          <Text className="text-white text-3xl font-bold">C</Text>
        </View>
        <Text className="text-white text-3xl font-bold tracking-tight">Cairn</Text>
        <Text className="text-zinc-400 text-base mt-1">Mobile Companion</Text>
      </View>

      {/* Demo workspace CTA — prominent for simulator testing */}
      <View className="w-full mb-6 bg-indigo-600/10 border border-indigo-500/30 rounded-2xl p-5">
        <Text className="text-indigo-300 text-xs font-semibold uppercase tracking-wider mb-1">
          Quick start
        </Text>
        <Text className="text-white font-semibold text-base mb-1">
          Create a demo workspace
        </Text>
        <Text className="text-zinc-400 text-sm leading-5 mb-4">
          Spin up a local workspace with sample projects, notes and tasks — no iCloud required. Perfect for trying the app.
        </Text>
        <Pressable
          onPress={createDemo}
          disabled={loading !== null}
          className="bg-indigo-600 rounded-xl py-3.5 items-center active:opacity-80"
        >
          {loading === "demo" ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text className="text-white font-semibold text-sm">Create demo workspace</Text>
          )}
        </Pressable>
      </View>

      {/* Divider */}
      <View className="flex-row items-center w-full mb-6 gap-3">
        <View className="flex-1 h-px bg-zinc-800" />
        <Text className="text-zinc-600 text-xs">or connect your desktop workspace</Text>
        <View className="flex-1 h-px bg-zinc-800" />
      </View>

      {/* iCloud steps */}
      <View className="w-full mb-6 gap-3">
        {[
          {
            step: "1",
            title: "Place your workspace in iCloud",
            body: "On your Mac, move your Cairn workspace folder inside iCloud Drive so it syncs to your iPhone.",
          },
          {
            step: "2",
            title: "Select workspace.db",
            body: 'Tap below and navigate to your Cairn workspace folder. Select the "workspace.db" file.',
          },
          {
            step: "3",
            title: "Stay in sync",
            body: "Cairn Mobile reads and writes the same SQLite file as the desktop app via iCloud.",
          },
        ].map(({ step, title, body }) => (
          <View key={step} className="flex-row gap-3 bg-zinc-900 rounded-xl p-4">
            <View className="w-6 h-6 rounded-full bg-zinc-700 items-center justify-center shrink-0 mt-0.5">
              <Text className="text-zinc-300 text-xs font-bold">{step}</Text>
            </View>
            <View className="flex-1">
              <Text className="text-white text-sm font-semibold mb-0.5">{title}</Text>
              <Text className="text-zinc-500 text-sm leading-5">{body}</Text>
            </View>
          </View>
        ))}
      </View>

      <Pressable
        onPress={pickDatabase}
        disabled={loading !== null}
        className="w-full border border-zinc-700 rounded-xl py-3.5 items-center active:opacity-80"
      >
        {loading === "pick" ? (
          <ActivityIndicator color="#6366f1" />
        ) : (
          <Text className="text-zinc-300 font-semibold text-sm">Select workspace.db</Text>
        )}
      </Pressable>

      <Text className="text-zinc-700 text-xs text-center mt-6 leading-5">
        Cairn Mobile only reads and writes the SQLite database. Your markdown files are never
        modified without your action.
      </Text>
    </ScrollView>
  );
}
