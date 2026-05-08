import { View, Text, ScrollView, TextInput, Pressable, Alert } from "react-native";
import { useState, useEffect } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { closeDb } from "../../db/client";
import { useStore } from "../../store/index";

const AI_CONFIG_KEY = "cairn:mobile:aiConfig";

interface AIConfig { provider: "openai" | "anthropic" | "groq"; apiKey: string; model: string; }

const MODELS: Record<AIConfig["provider"], string[]> = {
  openai:    ["gpt-4o", "gpt-4o-mini"],
  anthropic: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
  groq:      ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
};

export default function SettingsTab() {
  const router = useRouter();
  const dbPath = useStore((s) => s.dbPath);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);

  const [cfg, setCfg] = useState<AIConfig>({ provider: "anthropic", apiKey: "", model: "claude-sonnet-4-5" });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(AI_CONFIG_KEY).then((r) => { if (r) setCfg(JSON.parse(r)); });
  }, []);

  async function save() {
    await AsyncStorage.setItem(AI_CONFIG_KEY, JSON.stringify(cfg));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function disconnect() {
    Alert.alert("Disconnect workspace", "Removes the database connection from this device. Your data is not deleted.", [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: async () => {
        await closeDb();
        await AsyncStorage.multiRemove(["cairn:mobile:dbPath", "cairn:mobile:workspaceId"]);
        router.replace("/onboarding");
      }},
    ]);
  }

  const S = {
    label: { color: "#66635f", fontSize: 11, fontWeight: "600" as const, textTransform: "uppercase" as const, letterSpacing: 0.6, marginBottom: 6 },
    sectionTitle: { color: "#9e9a94", fontSize: 10, fontWeight: "600" as const, textTransform: "uppercase" as const, letterSpacing: 0.8, marginBottom: 8 },
    card: { backgroundColor: "#141414", borderRadius: 12, borderWidth: 1, borderColor: "#2a2a2a", padding: 16, gap: 14 as const },
    row: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "flex-start" as const },
    rowLabel: { color: "#66635f", fontSize: 13 },
    rowValue: { color: "#e8e4dc", fontSize: 13, textAlign: "right" as const, flex: 1, marginLeft: 16 },
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0d0d0d" }} edges={["top"]}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 40, gap: 20 }}>
        <Text style={{ color: "#e8e4dc", fontSize: 22, fontWeight: "700", letterSpacing: -0.3 }}>Settings</Text>

        {/* Workspace */}
        <View>
          <Text style={S.sectionTitle}>Workspace</Text>
          <View style={S.card}>
            <View style={S.row}>
              <Text style={S.rowLabel}>Name</Text>
              <Text style={S.rowValue}>{workspace?.name ?? "—"}</Text>
            </View>
            <View style={{ height: 1, backgroundColor: "#1f1f1f" }} />
            <View style={S.row}>
              <Text style={S.rowLabel}>Database</Text>
              <Text style={[S.rowValue, { fontFamily: "monospace", fontSize: 11 }]} numberOfLines={2}>
                {dbPath ?? "—"}
              </Text>
            </View>
          </View>
        </View>

        {/* AI provider */}
        <View>
          <Text style={S.sectionTitle}>AI Provider</Text>
          <View style={S.card}>
            {/* Provider */}
            <View>
              <Text style={S.label}>Provider</Text>
              <View style={{ flexDirection: "row", gap: 6 }}>
                {(["openai", "anthropic", "groq"] as AIConfig["provider"][]).map((p) => (
                  <Pressable
                    key={p}
                    onPress={() => setCfg((c) => ({ ...c, provider: p, model: MODELS[p][0] }))}
                    style={{ flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center", backgroundColor: cfg.provider === p ? "#7c6af7" : "#1a1a1a", borderWidth: 1, borderColor: cfg.provider === p ? "#7c6af7" : "#2a2a2a" }}
                  >
                    <Text style={{ fontSize: 11, fontWeight: "600", color: cfg.provider === p ? "#fff" : "#66635f", textTransform: "capitalize" }}>{p}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Model */}
            <View>
              <Text style={S.label}>Model</Text>
              <View style={{ gap: 5 }}>
                {MODELS[cfg.provider].map((m) => (
                  <Pressable
                    key={m}
                    onPress={() => setCfg((c) => ({ ...c, model: m }))}
                    style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: cfg.model === m ? "rgba(124,106,247,0.12)" : "#1a1a1a", borderWidth: 1, borderColor: cfg.model === m ? "#7c6af7" : "#2a2a2a" }}
                  >
                    <Text style={{ fontSize: 13, color: cfg.model === m ? "#9281ff" : "#9e9a94" }}>{m}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* API key */}
            <View>
              <Text style={S.label}>API Key</Text>
              <TextInput
                style={{ backgroundColor: "#1a1a1a", borderRadius: 8, borderWidth: 1, borderColor: "#2a2a2a", paddingHorizontal: 12, paddingVertical: 10, color: "#e8e4dc", fontSize: 13, fontFamily: "monospace" }}
                placeholder="sk-…"
                placeholderTextColor="#3a3835"
                value={cfg.apiKey}
                onChangeText={(v) => setCfg((c) => ({ ...c, apiKey: v }))}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <Pressable
              onPress={save}
              style={({ pressed }) => ({ backgroundColor: "#7c6af7", borderRadius: 8, paddingVertical: 12, alignItems: "center", opacity: pressed ? 0.8 : 1 })}
            >
              <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>{saved ? "Saved!" : "Save AI Config"}</Text>
            </Pressable>
          </View>
        </View>

        {/* Danger */}
        <View>
          <Text style={S.sectionTitle}>Workspace</Text>
          <Pressable
            onPress={disconnect}
            style={({ pressed }) => ({ borderRadius: 12, borderWidth: 1, borderColor: "#3f1515", backgroundColor: "rgba(239,68,68,0.06)", paddingVertical: 14, alignItems: "center", opacity: pressed ? 0.8 : 1 })}
          >
            <Text style={{ color: "#ef4444", fontSize: 13, fontWeight: "600" }}>Disconnect workspace</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
