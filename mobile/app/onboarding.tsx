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

  async function pickDatabase() {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: false });
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      const fullPath = asset.uri.replace("file://", "");
      const lastSlash = fullPath.lastIndexOf("/");
      const directory = fullPath.slice(0, lastSlash + 1);
      const filename = fullPath.slice(lastSlash + 1);

      setLoading("pick");
      await openDb(filename, directory);
      await loadWorkspaces();

      const workspaces = await queries.getWorkspaces();
      if (workspaces.length === 0) {
        Alert.alert("No workspaces found", "This doesn't appear to be a valid Cairn database.");
        setLoading(null);
        return;
      }

      const workspace = workspaces[0];
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

  async function createDemo() {
    try {
      setLoading("demo");
      const { workspaceId } = await createFreshWorkspace();
      await loadWorkspaces();
      await AsyncStorage.setItem(STORAGE_KEY_DB_PATH, JSON.stringify({ filename: DEMO_DB_FILENAME, directory: undefined }));
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
      className="flex-1 bg-bg"
      contentContainerClassName="flex-grow items-center justify-center px-6 py-16"
    >
      {/* Wordmark */}
      <View className="mb-12 items-center">
        <View className="w-14 h-14 rounded-xl bg-accent items-center justify-center mb-5">
          <Text style={{ color: "#fff", fontSize: 26, fontWeight: "700" }}>C</Text>
        </View>
        <Text style={{ color: "#e8e4dc", fontSize: 28, fontWeight: "700", letterSpacing: -0.5 }}>
          Cairn
        </Text>
        <Text style={{ color: "#66635f", fontSize: 14, marginTop: 3 }}>Mobile Companion</Text>
      </View>

      {/* Demo CTA */}
      <View className="w-full mb-5 bg-surface rounded-xl p-5" style={{ borderWidth: 1, borderColor: "#2a2a2a" }}>
        <View className="flex-row items-center gap-2 mb-3">
          <View className="w-1.5 h-1.5 rounded-full bg-accent" />
          <Text style={{ color: "#7c6af7", fontSize: 11, fontWeight: "600", letterSpacing: 0.8, textTransform: "uppercase" }}>
            Quick start
          </Text>
        </View>
        <Text style={{ color: "#e8e4dc", fontSize: 16, fontWeight: "600", marginBottom: 4 }}>
          Create a demo workspace
        </Text>
        <Text style={{ color: "#9e9a94", fontSize: 13, lineHeight: 19, marginBottom: 16 }}>
          Spin up a local workspace with sample projects, notes and tasks. No iCloud required.
        </Text>
        <Pressable
          onPress={createDemo}
          disabled={loading !== null}
          className="bg-accent rounded-lg py-3.5 items-center"
          style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
        >
          {loading === "demo"
            ? <ActivityIndicator color="#fff" />
            : <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>Create demo workspace</Text>
          }
        </Pressable>
      </View>

      {/* Divider */}
      <View className="flex-row items-center w-full mb-5 gap-3">
        <View className="flex-1 h-px bg-border" />
        <Text style={{ color: "#66635f", fontSize: 11 }}>or sync your desktop workspace</Text>
        <View className="flex-1 h-px bg-border" />
      </View>

      {/* Steps */}
      <View className="w-full mb-5 gap-2">
        {[
          { n: "1", t: "Place workspace in iCloud", b: "Move your Cairn workspace folder into iCloud Drive on your Mac." },
          { n: "2", t: "Select workspace.db",        b: "Tap below and pick the workspace.db file from your Cairn folder." },
          { n: "3", t: "Changes sync automatically", b: "Mobile reads and writes the same SQLite file as the desktop app." },
        ].map(({ n, t, b }) => (
          <View key={n} className="flex-row gap-3 bg-surface rounded-lg p-4" style={{ borderWidth: 1, borderColor: "#1f1f1f" }}>
            <View className="w-5 h-5 rounded-full bg-surface2 items-center justify-center shrink-0 mt-0.5">
              <Text style={{ color: "#9e9a94", fontSize: 11, fontWeight: "700" }}>{n}</Text>
            </View>
            <View className="flex-1">
              <Text style={{ color: "#e8e4dc", fontSize: 13, fontWeight: "600", marginBottom: 2 }}>{t}</Text>
              <Text style={{ color: "#66635f", fontSize: 12, lineHeight: 17 }}>{b}</Text>
            </View>
          </View>
        ))}
      </View>

      <Pressable
        onPress={pickDatabase}
        disabled={loading !== null}
        className="w-full rounded-lg py-3.5 items-center"
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, borderWidth: 1, borderColor: "#2a2a2a" })}
      >
        {loading === "pick"
          ? <ActivityIndicator color="#7c6af7" />
          : <Text style={{ color: "#9e9a94", fontSize: 14, fontWeight: "500" }}>Select workspace.db</Text>
        }
      </Pressable>

      <Text style={{ color: "#3a3835", fontSize: 11, textAlign: "center", marginTop: 20, lineHeight: 16 }}>
        Cairn Mobile never modifies your markdown files — only the SQLite database.
      </Text>
    </ScrollView>
  );
}
